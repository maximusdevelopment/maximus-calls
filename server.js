require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

const BASE_URL = 'https://maximus-calls.onrender.com';
const MAXIMUS_PHONE = '+19162229729';

app.get('/', (req, res) => {
  res.status(200).send('Maximus Twilio server is running');
});

app.post('/new-lead', (req, res) => {
  console.log('Webhook body:', JSON.stringify(req.body, null, 2));

  res.status(200).json({
    success: true,
    message: 'Webhook received'
  });

  let phone = req.body.phone || req.body.properties?.phone || req.body.phone_number;

  if (!phone) {
    console.log('No phone received');
    return;
  }

  phone = String(phone).replace(/\D/g, '');

  if (phone.length === 10) {
    phone = '+1' + phone;
  } else if (phone.length === 11 && phone.startsWith('1')) {
    phone = '+' + phone;
  } else {
    console.log('Invalid phone:', phone);
    return;
  }

  console.log('Formatted lead phone:', phone);

  setTimeout(async () => {
    try {
      await client.calls.create({
        to: phone,
        from: process.env.TWILIO_NUMBER,
        url: `${BASE_URL}/voice`,
        method: 'POST',

        // Synchronous AMD — simpler and more stable
        machineDetection: 'Enable',
        machineDetectionTimeout: 30
      });

      console.log('Call started to:', phone);
    } catch (err) {
      console.error('Twilio call error:', err.message);
    }
  }, 10000);
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const answeredBy = req.body.AnsweredBy;

  console.log('AnsweredBy:', answeredBy);

  if (answeredBy === 'human' || answeredBy === 'unknown') {
    twiml.say('Please hold while we connect you with Maximus Roofing.');

    const dial = twiml.dial({
      answerOnBridge: true,
      timeout: 25
    });

    dial.number(MAXIMUS_PHONE);
  } else {
    console.log('Machine or voicemail detected. Hanging up.');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
