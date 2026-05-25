require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.post('/new-lead', async (req, res) => {
    const phone = req.body.phone;

    console.log("New lead:", phone);

    setTimeout(async () => {
        try {
            await client.calls.create({
                url: 'https://maximus-calls.onrender.com/voice',
                to: phone,
                from: process.env.TWILIO_NUMBER,
                record: true
            });
        } catch (err) {
            console.error(err);
        }
    }, 10000);

    res.sendStatus(200);
});

app.post('/voice', (req, res) => {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    twiml.say("Hello, this is Maximus Roofing.");
    twiml.pause({ length: 3 });
    twiml.say("Please hold while we connect you.");

    res.type('text/xml');
    res.send(twiml.toString());
});

app.listen(3000, () => console.log("Server running"));

app.post('/amd', async (req, res) => {
  const answeredBy = req.body.AnsweredBy;
  const callSid = req.body.CallSid;

  console.log("AMD Result:", answeredBy);

  try {
    if (answeredBy === "human") {
      // ✅ CONNECT TO YOUR TEAM
      await client.calls(callSid).update({
        url: "https://maximus-calls.onrender.com/connect"
      });
    } else {
      // ❌ VOICEMAIL → HANG UP
      await client.calls(callSid).update({
        twiml: "<Response><Hangup/></Response>"
      });
    }
  } catch (err) {
    console.error(err);
  }

  res.sendStatus(200);
});

app.post('/connect', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  twiml.say("Connecting you now.");
  twiml.dial('+19162229729');

  res.type('text/xml');
  res.send(twiml.toString());
});

twiml.gather({
  numDigits: 1,
  timeout: 5,
  action: '/confirm'
});
twiml.say("Press 1 to connect with our roofing specialist.");

app.post('/confirm', (req, res) => {
  const digit = req.body.Digits;
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  if (digit === "1") {
    twiml.dial('+19162229729');
  } else {
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});
