require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint for Render
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Ahad CPA Voice Agent is running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const n8nWebhook = process.env.N8N_WEBHOOK_URL || 'https://scottde.app.n8n.cloud/webhook/nadia';

// Full memory like your Retell context
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';
  const isFirstMessage = !userSpeech;

  console.log(`[${callSid}] Incoming call - Speech: "${userSpeech}"`);

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
      conversation_ended: false,
      history: []
    };
  }
  const memory = conversationMemory[callSid];

  let agentText = "Sorry, I'm having a technical issue. Please try again later. Goodbye.";

  try {
    // Determine what to ask next
    let nextQuestion = '';
    if (!memory.first_name) {
      nextQuestion = 'May I have your first name?';
    } else if (!memory.last_name) {
      nextQuestion = 'And your last name?';
    } else if (!memory.email) {
      nextQuestion = "What's your email address?";
    } else if (!memory.phone) {
      nextQuestion = 'And your phone number?';
    } else if (!memory.previous_client) {
      nextQuestion = 'Have you worked with Ahad and Co before?';
    } else if (memory.previous_client === 'No' && !memory.referral_source) {
      nextQuestion = 'How did you hear about us?';
    } else if (!memory.call_reason) {
      nextQuestion = "What's the main reason for your call?";
    } else {
      nextQuestion = "Perfect! You're all set. You'll receive confirmation shortly. Thank you for calling Ahad and Co. Goodbye!";
    }

    // Build conversation history
    const messages = [
      {
        role: "system",
        content: `You are a receptionist for Ahad and Co CPA Firm.

STRICT INSTRUCTIONS:
- If this is the first message (no history), say: "Thanks for calling Ahad and Co CPA Firm. ${nextQuestion}"
- Otherwise, say EXACTLY: "${nextQuestion}"
- Do NOT add anything else
- Do NOT say "thank you" or repeat what the user said
- JUST ask the question`
      }
    ];

    // Add conversation history
    if (memory.history.length > 0) {
      memory.history.forEach(msg => messages.push(msg));
    }

    // Add current user input
    if (userSpeech) {
      messages.push({ role: "user", content: userSpeech });
    } else {
      messages.push({ role: "user", content: "FIRST_CALL_START" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 150
    });

    agentText = completion.choices[0].message.content.trim();

    // Save to history
    if (userSpeech) {
      memory.history.push({ role: "user", content: userSpeech });
    }
    memory.history.push({ role: "assistant", content: agentText });

    // STATE MACHINE: Extract information based ONLY on current step
    if (userSpeech && userSpeech.trim()) {
      const lowerSpeech = userSpeech.toLowerCase();

      // Determine current step based on what's missing
      if (!memory.first_name) {
        memory.step = 'collect_first_name';
      } else if (!memory.last_name) {
        memory.step = 'collect_last_name';
      } else if (!memory.email) {
        memory.step = 'collect_email';
      } else if (!memory.phone) {
        memory.step = 'collect_phone';
      } else if (!memory.previous_client) {
        memory.step = 'collect_previous_client';
      } else if (memory.previous_client === 'No' && !memory.referral_source) {
        memory.step = 'collect_referral';
      } else if (!memory.call_reason) {
        memory.step = 'collect_call_reason';
      } else {
        memory.step = 'complete';
      }

      // Extract based ONLY on current step
      switch (memory.step) {
        case 'collect_first_name':
          // Try to extract just the name (remove filler words)
          let firstName = userSpeech.trim();
          // Remove common prefixes
          firstName = firstName.replace(/^(yeah|yes|my first name is|my name is|it's|i'm|this is)\s*/i, '');
          firstName = firstName.replace(/\s+/g, ' ').trim();
          memory.first_name = firstName;
          console.log(`[${callSid}] Captured first_name: ${memory.first_name}`);
          break;

        case 'collect_last_name':
          // Try to extract just the name
          let lastName = userSpeech.trim();
          lastName = lastName.replace(/^(yeah|yes|my last name is|my surname is|it's|and|the last name is)\s*/i, '');
          lastName = lastName.replace(/\s+/g, ' ').trim();
          memory.last_name = lastName;
          console.log(`[${callSid}] Captured last_name: ${memory.last_name}`);
          break;

        case 'collect_email':
          // Clean up email - remove spaces and common prefixes
          let email = userSpeech.toLowerCase();
          email = email.replace(/^(my email is|my email address is|it's|it is|the email is)\s*/i, '');
          email = email.replace(/\s+/g, '');
          // Replace common words
          email = email.replace(/\bat\b/g, '@');
          email = email.replace(/\bdot\b/g, '.');
          memory.email = email;
          console.log(`[${callSid}] Captured email: ${memory.email}`);
          break;

        case 'collect_phone':
          // Extract only digits from phone
          memory.phone = userSpeech.replace(/\D/g, '');
          console.log(`[${callSid}] Captured phone: ${memory.phone}`);
          break;

        case 'collect_previous_client':
          // Simple yes/no detection
          if (lowerSpeech.includes('yes') || lowerSpeech.includes('yeah')) {
            memory.previous_client = 'Yes';
            memory.skip_referral_question = true;
          } else if (lowerSpeech.includes('no') || lowerSpeech.includes('nope')) {
            memory.previous_client = 'No';
          } else {
            // Default to No if unclear
            memory.previous_client = 'No';
          }
          console.log(`[${callSid}] Captured previous_client: ${memory.previous_client}`);
          break;

        case 'collect_referral':
          memory.referral_source = userSpeech.trim();
          console.log(`[${callSid}] Captured referral_source: ${memory.referral_source}`);
          break;

        case 'collect_call_reason':
          memory.call_reason = userSpeech.trim();
          console.log(`[${callSid}] Captured call_reason: ${memory.call_reason}`);
          break;
      }
    }

    console.log(`[${callSid}] Agent: "${agentText}"`);
    console.log(`[${callSid}] Memory:`, JSON.stringify(memory, null, 2));

  } catch (error) {
    console.error(`[${callSid}] Error in AI processing:`, error);
    agentText = "Sorry, there was a technical issue. Please try again later. Goodbye.";
  }

  // Check if booking complete and send to n8n
  const shouldBook = memory.first_name && memory.last_name && memory.email && memory.phone;
  if (shouldBook && !memory.booking_completed) {
    memory.booking_completed = true;
    console.log(`[${callSid}] Sending booking to n8n...`);

    try {
      await axios.post(n8nWebhook, {
        type: "appointment_booking",
        first_name: memory.first_name,
        last_name: memory.last_name,
        phone: memory.phone || req.body.From,
        email_address: memory.email,
        selected_slot: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        call_reason: memory.call_reason || "Tax consultation",
        referral_source: memory.referral_source || "Unknown",
        previous_client: memory.previous_client || "No",
        summary: `Appointment booked for ${memory.first_name} ${memory.last_name}`,
        timestamp: new Date().toISOString(),
        booking_status: "confirmed",
        call_sid: callSid
      }, {
        timeout: 5000
      });
      console.log(`[${callSid}] Booking sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // Check if conversation should end
  const shouldEnd = agentText.toLowerCase().includes("goodbye") || memory.conversation_ended;

  if (shouldEnd) {
    memory.conversation_ended = true;
    console.log(`[${callSid}] Conversation ended`);

    // Say goodbye and hangup
    twiml.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    twiml.hangup();

  } else {
    // Continue conversation - gather user input
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });

    // Generate and play audio inside gather
    try {
      // Try ElevenLabs TTS if configured
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
        const audioStream = await elevenlabs.generate({
          voice: process.env.ELEVENLABS_VOICE_ID,
          text: agentText,
          model_id: "eleven_multilingual_v2",
        });

        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of audioStream) {
          chunks.push(Buffer.from(chunk));
        }
        const audioBuffer = Buffer.concat(chunks);

        // Upload to tmpfiles.org for public MP3 URL
        const formData = new FormData();
        formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
        const uploadResponse = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
          headers: formData.getHeaders(),
          timeout: 10000
        });

        const audioUrl = uploadResponse.data?.data?.url?.replace('tmpfiles.org/', 'tmpfiles.org/dl/') || uploadResponse.data?.files?.file?.url?.full;

        if (audioUrl) {
          gather.play(audioUrl);
          console.log(`[${callSid}] Playing ElevenLabs audio`);
        } else {
          // Fallback to Twilio
          gather.say({
            voice: "Polly.Joanna-Neural",
            language: "en-US"
          }, agentText);
          console.log(`[${callSid}] ElevenLabs URL failed, using Twilio TTS`);
        }
      } else {
        // Use Twilio TTS
        gather.say({
          voice: "Polly.Joanna-Neural",
          language: "en-US"
        }, agentText);
        console.log(`[${callSid}] Using Twilio TTS`);
      }
    } catch (audioError) {
      console.error(`[${callSid}] Audio generation error:`, audioError.message);
      // Fallback to basic Twilio TTS
      gather.say({
        voice: "Polly.Joanna-Neural",
        language: "en-US"
      }, agentText);
    }

    // If no response after timeout, redirect to continue
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
