import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCheckout } from './hooks';
import { toCourse } from './models';
import { ApiError } from './client';
import * as client from './client';

afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.Razorpay; document.querySelectorAll('script[src*="checkout.razorpay.com"]').forEach(s => s.remove()); });

const course = toCourse({ _id: 'course-1', title: 'Paid course', accessType: 'PAID', price: 500 });
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useCheckout(course), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
}
const coded = (status: number, code: string) => new ApiError(status, 'provider-secret internal payment details', undefined, { code });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('checkout recovery', () => {
  const reusable = { success: true, code: 'PAYMENT_ORDER_REUSABLE', purchase: { status: 'PENDING' }, order: { id: 'order-existing', amount: 500, currency: 'INR' }, keyId: 'public-key' };

  it.each(['response', 'error'].flatMap(outcome => ['verifying', 'pending', 'success'].map(verificationState => [outcome, verificationState])))('ignores delayed order %s after a callback takes ownership in %s', async (outcome, verificationState) => {
    const recoveryOrder = deferred<any>(); const verification = deferred<any>();
    let orders = 0; let verifications = 0;
    const request = vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path === '/payments/orders') return ++orders === 1 ? reusable : recoveryOrder.promise;
      return ++verifications === 1 ? verification.promise : { success: true };
    });
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    const payload = { razorpay_order_id: 'order-existing', razorpay_payment_id: 'payment-1', razorpay_signature: 'signature' };
    const { result } = setup();
    await act(() => result.current.start());
    act(() => options[0].modal.ondismiss());
    let recovering!: Promise<void>; let verifying!: Promise<void>;
    act(() => { recovering = result.current.start(); });
    act(() => { verifying = options[0].handler(payload); });
    expect(result.current.state.phase).toBe('verifying');
    if (verificationState !== 'verifying') {
      await act(async () => {
        if (verificationState === 'pending') verification.reject(coded(503, 'PAYMENT_VERIFICATION_UNAVAILABLE'));
        else verification.resolve({ success: true });
        await verifying;
      });
    }
    expect(result.current.state.phase).toBe(verificationState);
    await act(async () => {
      if (outcome === 'response') recoveryOrder.resolve(reusable);
      else recoveryOrder.reject(coded(503, 'PAYMENT_ORDER_UNAVAILABLE'));
      await recovering;
    });
    expect(result.current.state.phase).toBe(verificationState);
    expect(options).toHaveLength(1);
    expect(orders).toBe(2);
    if (verificationState === 'pending') {
      expect(result.current.state.guidance?.actions.map(action => action.kind)).toEqual(['purchases', 'retry']);
      await act(() => result.current.retryVerification());
      expect(request.mock.calls.filter(([path]) => path === '/payments/verify').map(([, options]) => options?.body)).toEqual([payload, payload]);
      expect(result.current.state.phase).toBe('success');
      expect(orders).toBe(2);
    } else if (verificationState === 'verifying') {
      await act(async () => { verification.resolve({ success: true }); await verifying; });
      expect(result.current.state.phase).toBe('success');
    }
  });

  it.each(['load', 'error'].flatMap(outcome => ['pending', 'success'].map(verificationState => [outcome, verificationState])))('ignores delayed script %s after a callback reaches %s', async (outcome, verificationState) => {
    const request = vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path === '/payments/orders') return reusable;
      if (verificationState === 'pending') throw coded(503, 'PAYMENT_VERIFICATION_UNAVAILABLE');
      return { success: true };
    });
    const options: any[] = [];
    const constructor = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    window.Razorpay = constructor;
    const { result } = setup();
    await act(() => result.current.start());
    act(() => options[0].modal.ondismiss());
    delete window.Razorpay;
    let recovering!: Promise<void>;
    act(() => { recovering = result.current.start(); });
    await waitFor(() => expect(document.querySelector('script[src*="checkout.razorpay.com"]')).not.toBeNull());
    await act(() => options[0].handler({ razorpay_order_id: 'order-existing', razorpay_payment_id: 'payment-1', razorpay_signature: 'signature' }));
    expect(result.current.state.phase).toBe(verificationState);
    window.Razorpay = constructor;
    await act(async () => {
      document.querySelector('script[src*="checkout.razorpay.com"]')!.dispatchEvent(new Event(outcome));
      await recovering;
    });
    expect(result.current.state.phase).toBe(verificationState);
    expect(options).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === '/payments/orders')).toHaveLength(2);
  });

  it('invalidates delayed checkout work when switching away and back to the same course', async () => {
    const oldOrder = deferred<any>(); let orders = 0;
    vi.spyOn(client, 'api').mockImplementation(async () => ++orders === 1 ? oldOrder.promise : reusable);
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    const qc = new QueryClient();
    const { result, rerender } = renderHook(({ selected }) => useCheckout(selected), {
      initialProps: { selected: course },
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    let stale!: Promise<void>;
    act(() => { stale = result.current.start(); });
    rerender({ selected: toCourse({ _id: 'course-2', title: 'Another paid course', accessType: 'PAID', price: 500 }) });
    rerender({ selected: course });
    await act(() => result.current.start());
    expect(options).toHaveLength(1);
    await act(async () => { oldOrder.resolve(reusable); await stale; });
    expect(options).toHaveLength(1);
    expect(result.current.state.phase).toBe('awaiting');
  });

  it.each(['course round trip', 'replacement window', 'course round trip before restart'])('ignores an obsolete payment callback after %s', async transition => {
    const request = vi.spyOn(client, 'api').mockImplementation(async path => path === '/payments/orders' ? reusable : { success: true });
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    const qc = new QueryClient();
    const { result, rerender } = renderHook(({ selected }) => useCheckout(selected), {
      initialProps: { selected: course },
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await act(() => result.current.start());
    if (transition === 'replacement window') act(() => options[0].modal.ondismiss());
    else {
      rerender({ selected: toCourse({ _id: 'course-2', title: 'Another paid course', accessType: 'PAID', price: 500 }) });
      rerender({ selected: course });
    }
    if (transition !== 'course round trip before restart') await act(() => result.current.start());
    const previousState = result.current.state;
    const requestsBeforeCallback = request.mock.calls.length;
    const windowsBeforeCallback = options.length;
    const oldPayload = { razorpay_order_id: 'order-existing', razorpay_payment_id: 'payment-obsolete', razorpay_signature: 'old-signature' };
    await act(async () => { await options[0].handler(oldPayload); });
    expect(result.current.state).toBe(previousState);
    expect(request).toHaveBeenCalledTimes(requestsBeforeCallback);
    expect(request.mock.calls.filter(([path]) => path === '/payments/verify')).toHaveLength(0);
    expect(options).toHaveLength(windowsBeforeCallback);

    // The current window can still verify; rejecting obsolete handlers must not
    // disable a valid payment from the new course lifecycle/window.
    if (transition === 'course round trip before restart') await act(() => result.current.start());
    const currentPayload = { ...oldPayload, razorpay_payment_id: 'payment-current', razorpay_signature: 'current-signature' };
    await act(() => options[1].handler(currentPayload));
    expect(request.mock.calls.filter(([path]) => path === '/payments/verify').map(([, options]) => options?.body)).toEqual([currentPayload]);
    expect(result.current.state.phase).toBe('success');
  });

  it('allows cancelled unpaid checkout to reopen the same order after checking the server', async () => {
    const api = vi.spyOn(client, 'api').mockResolvedValue(reusable);
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    const { result } = setup();
    await act(() => result.current.start());
    act(() => options[0].modal.ondismiss());
    expect(result.current.state.phase).toBe('cancelled');
    expect(result.current.state.guidance?.action).toMatchObject({ kind: 'retry', label: 'Resume checkout' });
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('awaiting');
    expect(options.map(o => o.order_id)).toEqual(['order-existing', 'order-existing']);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('recovers script-load failure by rechecking and reopening the same unpaid order', async () => {
    const api = vi.spyOn(client, 'api').mockResolvedValue(reusable);
    const { result } = setup();
    let pending: Promise<void>;
    act(() => { pending = result.current.start(); });
    await waitFor(() => expect(document.querySelector('script[src*="checkout.razorpay.com"]')).not.toBeNull());
    await act(async () => { document.querySelector('script[src*="checkout.razorpay.com"]')!.dispatchEvent(new Event('error')); await pending; });
    expect(result.current.state.guidance?.action).toMatchObject({ kind: 'retry', label: 'Resume checkout' });
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    await act(() => result.current.start());
    expect(options[0].order_id).toBe('order-existing');
    expect(api).toHaveBeenCalledTimes(2);
    expect(result.current.state.phase).toBe('awaiting');
  });

  it('recovers a lost order response after remount using the server-approved reusable order', async () => {
    const api = vi.spyOn(client, 'api').mockRejectedValueOnce(new ApiError(0, 'secret network internals')).mockResolvedValue(reusable);
    const first = setup();
    await act(() => first.result.current.start());
    expect(first.result.current.state.phase).toBe('failed');
    first.unmount();
    const options: any[] = [];
    window.Razorpay = function Razorpay(value: any) { options.push(value); return { on: vi.fn(), open: vi.fn() }; };
    const restarted = setup();
    await act(() => restarted.result.current.start());
    expect(restarted.result.current.state.phase).toBe('awaiting');
    expect(options[0].order_id).toBe('order-existing');
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.every(([path]) => path === '/payments/orders')).toBe(true);
  });

  it('never reopens the modal when the server says payment was submitted, even after remount', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({ success: true, code: 'PAYMENT_VERIFICATION_PENDING', purchase: { status: 'PENDING' } });
    const razorpay = vi.fn(); window.Razorpay = razorpay;
    const first = setup(); await act(() => first.result.current.start()); first.unmount();
    const restarted = setup(); await act(() => restarted.result.current.start());
    expect(restarted.result.current.state.phase).toBe('pending');
    expect(restarted.result.current.state.guidance?.action).toMatchObject({ kind: 'purchases' });
    expect(razorpay).not.toHaveBeenCalled();
  });
  it('keeps checkout recovery scoped to its course when the learner opens another course', async () => {
    const api = vi.spyOn(client, 'api').mockImplementation(async (_path, options) => (options?.body as { courseId: string }).courseId === 'course-1'
      ? { success: true, code: 'PAYMENT_ORDER_PENDING' }
      : { success: true, order: { id: 'order-new', amount: 500 }, keyId: 'public-key' });
    window.Razorpay = vi.fn(function Razorpay() { return { on: vi.fn(), open: vi.fn() }; });
    const qc = new QueryClient();
    const { result, rerender } = renderHook(({ selected }) => useCheckout(selected), {
      initialProps: { selected: course },
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('pending');
    rerender({ selected: toCourse({ _id: 'course-2', title: 'Another paid course', accessType: 'PAID', price: 500 }) });
    expect(result.current.state.phase).toBe('idle');
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('awaiting');
    expect(api.mock.calls.filter(([path]) => path === '/payments/orders')).toHaveLength(2);
  });
  it.each([
    { success: true, code: 'PAYMENT_VERIFICATION_PENDING', purchase: { status: 'PENDING' } },
    { success: false, error: { code: 'PAYMENT_ORDER_PENDING', message: 'private provider message' } },
  ])('keeps submitted or legacy-ambiguous pending payment out of the payment window: %j', async body => {
    const api = vi.spyOn(client, 'api').mockResolvedValue(body);
    const razorpay = vi.fn(function Razorpay() { return { on: vi.fn(), open: vi.fn() }; }); window.Razorpay = razorpay;
    const { result } = setup();
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('pending');
    expect(result.current.state.guidance?.action).toMatchObject({ kind: 'purchases', href: '/student/purchases' });
    expect(result.current.state.message).toMatch(/do not pay again/i);
    expect(razorpay).not.toHaveBeenCalled();
    await act(() => result.current.start());
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('lets a reservation contender check the same order again without opening a second checkout', async () => {
    const api = vi.spyOn(client, 'api').mockResolvedValueOnce({ success: false, error: { code: 'PAYMENT_ORDER_PREPARING' } }).mockResolvedValue(reusable);
    const razorpay = vi.fn(function Razorpay() { return { on: vi.fn(), open: vi.fn() }; }); window.Razorpay = razorpay;
    const { result } = setup();
    await act(() => result.current.start());
    expect(razorpay).not.toHaveBeenCalled();
    expect(result.current.state.guidance?.action).toMatchObject({ kind: 'retry', label: 'Check checkout' });
    await act(() => result.current.start());
    expect(razorpay).toHaveBeenCalledOnce();
    expect(result.current.state.phase).toBe('awaiting');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('rechecks provider state after an order lookup outage instead of offering a callback-only verification retry', async () => {
    const api = vi.spyOn(client, 'api').mockRejectedValueOnce(coded(503, 'PAYMENT_VERIFICATION_UNAVAILABLE')).mockResolvedValue(reusable);
    const razorpay = vi.fn(function Razorpay() { return { on: vi.fn(), open: vi.fn() }; }); window.Razorpay = razorpay;
    const { result } = setup();
    await act(() => result.current.start());
    expect(result.current.state.guidance?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'retry', label: 'Check checkout' })]));
    await act(() => result.current.start());
    expect(razorpay).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('recovers a payment window startup failure without leaving checkout stuck awaiting', async () => {
    vi.spyOn(client, 'api').mockResolvedValue(reusable);
    window.Razorpay = function Razorpay() { throw new Error('private script initialization details'); };
    const { result } = setup();
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('failed');
    expect(result.current.state.guidance?.action).toMatchObject({ kind: 'retry', label: 'Resume checkout' });
    expect(result.current.state.message).not.toContain('private');
    window.Razorpay = vi.fn(function Razorpay() { return { on: vi.fn(), open: vi.fn() }; });
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('awaiting');
  });

  it.each([
    { success: true, code: 'PAYMENT_ALREADY_OWNED', purchase: { status: 'VERIFIED' } },
    { success: true, access: { granted: true, status: 'ACTIVE', source: 'PURCHASE' } },
  ])('offers learning for idempotent ownership responses without opening payment: %j', async body => {
    vi.spyOn(client, 'api').mockResolvedValue(body);
    const razorpay = vi.fn(); window.Razorpay = razorpay;
    const { result } = setup();
    await act(() => result.current.start());
    expect(result.current.state.phase).toBe('owned');
    expect(result.current.state.guidance?.action).toMatchObject({ kind: 'learning', href: '/student/my-learning' });
    expect(razorpay).not.toHaveBeenCalled();
  });

  it('does not mistake every 409 for ownership', async () => {
    vi.spyOn(client, 'api').mockRejectedValue(coded(409, 'PAYMENT_ORDER_CONFLICT'));
    const { result } = setup();
    await act(() => result.current.start());
    expect(result.current.state.phase).not.toBe('owned');
    expect(result.current.state.message).not.toMatch(/own this course|provider-secret/);
  });

  it('retries verification with the same callback after an outage and never creates another order', async () => {
    let options: any;
    window.Razorpay = function Razorpay(value: any) { options = value; return { on: vi.fn(), open: vi.fn() }; };
    const payload = { razorpay_order_id: 'order-1', razorpay_payment_id: 'payment-1', razorpay_signature: 'signature' };
    let verifications = 0;
    const api = vi.spyOn(client, 'api').mockImplementation(async path => {
      if (path === '/payments/orders') return { success: true, order: { id: 'order-1', amount: 500 }, keyId: 'public-key' };
      if (++verifications === 1) throw coded(503, 'PAYMENT_VERIFICATION_UNAVAILABLE');
      return { success: true, purchase: { status: 'VERIFIED' } };
    });
    const { result } = setup();
    await act(() => result.current.start());
    await act(() => options.handler(payload));
    expect(result.current.state.phase).toBe('pending');
    expect(result.current.state.guidance?.actions.map(action => action.kind)).toEqual(['purchases', 'retry']);
    expect(result.current.state.message).not.toContain('provider-secret');
    await act(() => result.current.start());
    expect(api.mock.calls.filter(([path]) => path === '/payments/orders')).toHaveLength(1);
    await act(() => result.current.retryVerification());
    expect(api.mock.calls.filter(([path]) => path === '/payments/verify').map(([, options]) => options?.body)).toEqual([payload, payload]);
    expect(result.current.state.phase).toBe('success');
  });

  it('ignores arbitrary payment-provider failure descriptions', async () => {
    let failure: (response: any) => void = () => {};
    window.Razorpay = function Razorpay() { return { on: (_name: string, handler: typeof failure) => { failure = handler; }, open: vi.fn() }; };
    vi.spyOn(client, 'api').mockResolvedValue({ success: true, order: { id: 'order-1', amount: 500 }, keyId: 'public-key' });
    const { result } = setup();
    await act(() => result.current.start());
    act(() => failure({ error: { description: 'provider-secret internal payment details' } }));
    expect(result.current.state.message).not.toContain('provider-secret');
    expect(result.current.state.guidance?.actions.map(action => action.kind)).toContain('purchases');
  });
});
