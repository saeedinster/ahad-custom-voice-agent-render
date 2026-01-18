require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.urlencoded({ extended: true }));

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const n8nWebhook = process.env.N8N_WEBHOOK;

// Full memory like your YML context_memory
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';

  if (!conversationMemory[callSid]) {
    conversationMemory[callSid] = {
      step: 'greeting',
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      previous_client: null,
      skip_referral_question: false,
      referral_source: null,
      call_reason: null,
      selected_slot: null,
      selected_slot_iso: null,
      booking_completed: false,
      conversation_ended: false
    };
  }
  const memory = conversationMemory[callSid];

  // OpenAI prompt — matches your YML flow exactly
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `You are a friendly CPA receptionist for Ahad and Co CPA Firm. Follow this exact flow from Retell YML:

      - Greet: "Thanks for calling Ahad and Co CPA Firm. How can I help you today?" (speak naturally, professional pace)

      - Intent handling:
        - Returning client: "Welcome back. I see you're a returning client." → store previous_client=Yes, skip_referral_question=Yes → booking
        - Appointment request: "Great. Let's schedule a free 15-minute consultation." → booking
        - Personal tax / individual tax: "We'd love to help with that. Let's schedule a free 15-minute consultation." → booking
        - Business tax / business accounting: "We can help. Let's schedule a free 15-minute consultation." → booking
        - Specific person: "Unfortunately no one is available currently. Would you like to make an appointment?" → booking or message
        - Default: "I can book a free consultation. Would you like to schedule?" → booking or message

      - Booking flow:
        - Check earliest slot.
        - Collect first_name: "May I have your first name? Please spell it out slowly and clearly."
        - Collect last_name: same
        - Collect email: "What is your email address? Please spell it out very slowly, one letter at a time, pause after each letter." → repeat full email slowly → confirm once
        - Collect phone: "And your phone number?"
        - Previous client: "Have you used Ahad and Co before?" (only ask once)
        - Referral: "How did you hear about us?" (skip if previous_client=Yes)
        - Call reason: "What's the main reason for your call?"

      - Book appointment.
      - Send to n8n on booking.
      - End with one "Goodbye" — stop conversation.

      Remember context: do not repeat questions. Speak slowly for spelling. Never repeat "Goodbye".` },
      { role: "user", content: userSpeech || "start" },
      { role: "assistant", content: `Current memory: ${JSON.stringify(memory)}` }
    ],
  });
  let agentText = completion.choices[0].message.content.trim();

  // Update memory from LLM response
  if (agentText.toLowerCase().includes("previous client")) memory.previous_client = agentText.includes("Yes") ? "Yes" : "No";
  if (memory.previous_client === "Yes") memory.skip_referral_question = true;
  if (agentText.toLowerCase().includes("referral")) memory.referral_source = agentText.match(/referral: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("first name")) memory.first_name = agentText.match(/first name: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("last name")) memory.last_name = agentText.match(/last name: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("email")) memory.email = agentText.match(/email: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("phone")) memory.phone = agentText.match(/phone: (.*)/)?.[1] || null;
  if (agentText.toLowerCase().includes("reason")) memory.call_reason = agentText.match(/reason: (.*)/)?.[1] || null;

  // ElevenLabs TTS (Grace voice, slow & clear)
  const audioStream = await elevenlabs.generate({
    voice: process.env.ELEVENLABS_VOICE_ID,
    text: agentText,
    model_id: "eleven_multilingual_v2",
  });

  // Upload audio to tmpfiles.org for public MP3 URL
  const formData = new FormData();
  formData.append('file', audioStream, 'audio.mp3');
  const uploadResponse = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
    headers: formData.getHeaders()
  });
  const audioUrl = uploadResponse.data.files.file.url.full; // Public URL

  // Play audio to caller
  twiml.play({ url: audioUrl });

  // Send to n8n if booked
  if (agentText.toLowerCase().includes("booked")) {
    memory.booking_completed = true;
    await axios.post(n8nWebhook, {
      type: "appointment_booking",
      first_name: memory.first_name || "Unknown",
      last_name: memory.last_name || "Unknown",
      phone: memory.phone || req.body.From,
      email_address: memory.email || "unknown@example.com",
      selected_slot: "2026-01-20T11:00:00",
      call_reason: memory.call_reason || "Tax consultation",
      referral_source: memory.referral_source || "Unknown",
      previous_client: memory.previous_client || "No",
      summary: agentText,
      timestamp: new Date().toISOString(),
      booking_status: "confirmed"
    });
  }

  // End call if ended
  if (agentText.toLowerCase().includes("goodbye")) memory.conversation_ended = true;

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
