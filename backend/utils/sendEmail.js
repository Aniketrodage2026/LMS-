const nodemailer = require('nodemailer');

const sendEmail = async ({ email, subject, message }) => {
  try {
    // 1. Create transporter
    const transporter = nodemailer.createTransport({
      service: "gmail", // you can replace with smtp host if needed
      auth: {
        user: process.env.SMTP_EMAIL,      // your gmail
        pass: process.env.SMTP_PASSWORD,   // app-specific password
      },
    });

    // 2. Define email options
    const mailOptions = {
      from: `"LMS Support" <${process.env.SMTP_EMAIL}>`,
      to: email,       // receiver
      subject,         // subject
      text: message,   // plain text
      // html: `<p>${message}</p>`  // optional html version
    };

    // 3. Send email
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: %s", info.messageId);

  } catch (error) {
    console.error("Email send error: ", error.message);
    throw error;
  }
};

module.exports = sendEmail;
