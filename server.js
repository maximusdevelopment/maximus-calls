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
                url: 'url: 'https://maximus-calls.onrender.com/voice',
                to: phone,
                from: process.env.TWILIO_NUMBER
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

    twiml.say("Hello, this is Maximus Roofing. Connecting you now.");

    twiml.dial('9162229729');

    res.type('text/xml');
    res.send(twiml.toString());
});

app.listen(3000, () => console.log("Server running"));
