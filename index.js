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
const n8nWebhook = process.env.N8N_WEBHOOK_URL || 'https://scottde.app.n8n.cloud/webhook/TestAhadCPA';

// Import prompts from external file
const { buildAllPrompts } = require('./prompts');

// Cal.com Configuration
const calComApiKey = process.env.CALCOM_API_KEY;
const calComEventTypeId = process.env.CALCOM_EVENT_TYPE_ID;
const calComTimezone = process.env.CALCOM_TIMEZONE || 'America/New_York';

// ===== HELPER FUNCTIONS =====

// Cal.com: Get available slots for next 2 weeks
async function getCalendarAvailability(startDate, endDate, preferredTime = null) {
  if (!calComApiKey || !calComEventTypeId) {
    console.log('Cal.com not configured, returning mock slots');
    return null;
  }

  try {
    const params = new URLSearchParams({
      apiKey: calComApiKey,
      eventTypeId: calComEventTypeId,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      timeZone: calComTimezone
    });

    // Cal.com API - use /slots endpoint for getting available booking slots
    const response = await axios.get(
      `https://api.cal.com/v1/slots?${params.toString()}`,
      { timeout: 10000 }
    );

    console.log('Cal.com API response:', JSON.stringify(response.data, null, 2));

    // Cal.com returns slots as object with dates as keys: { "2024-01-15": ["time1", "time2"], ... }
    const slotsData = response.data?.slots || {};

    // Flatten all slots from all dates into a single array
    const allSlots = [];
    for (const date of Object.keys(slotsData).sort()) {
      const timesForDate = slotsData[date];
      if (Array.isArray(timesForDate)) {
        for (const timeObj of timesForDate) {
          // Cal.com can return either string times or objects with 'time' property
          const timeStr = typeof timeObj === 'string' ? timeObj : timeObj.time;
          allSlots.push(timeStr);
        }
      }
    }

    console.log(`Cal.com found ${allSlots.length} total slots`);

    // Return top 5 slots formatted for conversation
    return allSlots.slice(0, 5).map(time => ({
      start: new Date(time),
      end: new Date(new Date(time).getTime() + 15 * 60 * 1000), // 15-minute slots
      iso: time,
      displayText: formatSlotForSpeech(new Date(time))
    }));
  } catch (error) {
    console.error('Cal.com API error:', error.message);
    return null;
  }
}

// Format date for natural speech
function formatSlotForSpeech(date) {
  const options = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: calComTimezone
  };
  return date.toLocaleDateString('en-US', options);
}

// Cal.com: Create booking
async function createCalComBooking(slotISO, userInfo) {
  if (!calComApiKey || !calComEventTypeId) {
    console.log('Cal.com not configured, skipping booking creation');
    return null;
  }

  try {
    const response = await axios.post(
      `https://api.cal.com/v1/bookings?apiKey=${calComApiKey}`,
      {
        eventTypeId: parseInt(calComEventTypeId),
        start: slotISO,
        lengthInMinutes: 15,  // 15-minute consultation
        responses: {
          name: `${userInfo.first_name} ${userInfo.last_name}`,
          email: userInfo.email,
          phone: userInfo.phone,
          notes: userInfo.call_reason || ''
        },
        timeZone: calComTimezone,
        language: 'en'
      },
      { timeout: 10000 }
    );

    console.log('Cal.com booking created:', response.data?.id);
    return response.data;
  } catch (error) {
    console.error('Cal.com booking error:', error.message);
    return null;
  }
}

// Detect slot acceptance from user speech
function detectSlotAcceptance(speech, offeredSlots) {
  if (!offeredSlots || offeredSlots.length === 0) return null;

  const lower = speech.toLowerCase().trim();

  // Check for specific slot selection
  if (/(first|1|one)/i.test(lower) && offeredSlots[0]) return offeredSlots[0];
  if (/(second|2|two)/i.test(lower) && offeredSlots[1]) return offeredSlots[1];
  if (/(third|3|three)/i.test(lower) && offeredSlots[2]) return offeredSlots[2];
  if (/(fourth|4|four)/i.test(lower) && offeredSlots[3]) return offeredSlots[3];
  if (/(fifth|5|five)/i.test(lower) && offeredSlots[4]) return offeredSlots[4];

  // Generic acceptance patterns (more flexible - can appear anywhere in response)
  // Includes patterns like "Okay. Yes, it can." or "Yes that works" or "Sure"
  if (/(^|\s)(yes|yeah|sure|ok|okay|that works|sounds good|perfect|works for me|either|both|any)($|[\s.,!])/i.test(lower)) {
    return offeredSlots[0];
  }

  // Check for explicit rejection to avoid false positives
  if (/(no|nope|not|don't|none|neither)/i.test(lower)) {
    return null;
  }

  return null;
}

// Intent detection using keywords (fallback)
function detectIntentByKeywords(speech) {
  const lower = speech.toLowerCase();

  // INQUIRY patterns (new) - asking questions, not booking
  if (/(inquir|question|information|tell me about|what do you|ask about|tax services|speak to|talk to|someone|person|representative|human|give me a name|looking for)/i.test(lower)) {
    return 'inquiry';  // NEW: Route to office hours message ONLY
  }

  // OFFICE HOURS question (new) - asking about business hours
  if (/(office hours|when.*open|what time|hours|open|times|available times)/i.test(lower)) {
    return 'office_hours_question';  // NEW: Explain hours, then offer message OR booking
  }

  // APPOINTMENT patterns - clear booking intent
  if (/(appointment|book|schedule|consultation|make.*appointment|set up|meeting|slot)/i.test(lower)) {
    return 'appointment';
  }

  // CALL BACK patterns - user says they'll call back later (end call immediately)
  if (/(i'll call back|call you back|call back later|i will call back|calling back)/i.test(lower)) {
    return 'callback';  // End call with "No problem. Goodbye."
  }

  // MESSAGE patterns
  if (/(message|leave.*message|voice.*mail)/i.test(lower)) {
    return 'message';
  }

  return 'unclear';
}

// Extract name from speech (improved - very lenient for voice input)
function extractName(speech) {
  let name = speech.trim();
  console.log(`Extracting name from: "${name}"`);

  // Remove common conversation prefixes (including comma-separated ones)
  name = name.replace(/^(sure,?|okay,?|yes,?|yeah,?|um,?|uh,?|well,?)\s*/i, '');

  // Remove "my name is" patterns
  name = name.replace(/^(my (first|last) name is|my name is|it's|i'm|this is|the name is|i am|call me)\s*/i, '');

  // Remove trailing punctuation
  name = name.replace(/[.,!?]$/g, '');

  // Clean up extra spaces
  name = name.replace(/\s+/g, ' ').trim();

  // Reject if contains question mark
  if (/\?/.test(name)) {
    console.log(`Invalid name detected: "${name}" - contains question mark`);
    return '';
  }

  // Reject if it looks like a sentence (contains common verbs/pronouns that aren't names)
  // These patterns indicate user is trying to say something other than their name
  if (/\b(would like|want to|need to|have to|going to|trying to|call me back|call back|about the|about my|someone|please)\b/i.test(name)) {
    console.log(`Invalid name detected: "${name}" - looks like a sentence, not a name`);
    return '';
  }

  // Reject if starts with "I " (pronoun) - common in sentences
  if (/^I\s/i.test(name)) {
    console.log(`Invalid name detected: "${name}" - starts with 'I'`);
    return '';
  }

  // Take only the first 3 words max (to handle "John Michael Smith" but not long sentences)
  const words = name.split(' ');
  if (words.length > 3) {
    name = words.slice(0, 3).join(' ');
    console.log(`Name truncated to first 3 words: "${name}"`);
  }

  // If name is too short (less than 1 character), reject
  if (name.length < 1) {
    console.log(`Invalid name detected: "${name}" - too short`);
    return '';
  }

  console.log(`Extracted name: "${name}"`);
  return name;
}

// Extract email from speech (improved - more lenient for voice input)
function extractEmail(speech) {
  let email = speech.toLowerCase().trim();
  console.log(`Extracting email from: "${email}"`);

  // Remove conversation prefixes
  email = email.replace(/^(sure,?|okay,?|yes,?|yeah,?|um,?|uh,?|it's|my email( address)? is|the email is)\s*/gi, '');

  // FIRST: Convert speech to email format BEFORE removing spaces (word boundaries need spaces)
  email = email.replace(/\s+at\s+/gi, '@');
  email = email.replace(/\bat\b/gi, '@');
  email = email.replace(/\s+dot\s+/gi, '.');
  email = email.replace(/\bdot\b/gi, '.');

  // Handle spelled out letters with spaces (e.g., "s a e e d")
  // If mostly single letters with spaces, join them
  const words = email.split(/\s+/);
  if (words.length > 3 && words.filter(w => w.length === 1).length > words.length / 2) {
    email = words.join('');
  }

  // NOW remove remaining spaces
  email = email.replace(/\s+/g, '');

  // Clean up common speech-to-text issues
  email = email.replace(/\.+$/g, '');  // Remove trailing dots
  email = email.replace(/@@+/g, '@');  // Fix double @
  email = email.replace(/\.\.+/g, '.'); // Fix double dots

  console.log(`Processed email: "${email}"`);

  // More lenient validation - just needs @ and something after it
  // Accept if it has @ and at least looks like an email
  if (!/@/.test(email)) {
    console.log(`Invalid email detected: "${email}" - missing @`);
    return '';
  }

  // If it has @ but no dot, still accept it (user might have said domain wrong)
  // We'll confirm with them anyway
  return email;
}

// Spell out email for TTS - spell username letter by letter, but say common domains naturally
// Example: "saeed@gmail.com" -> "S. A. E. E. D. ... at gmail dot com"
// Example: "john.doe@yahoo.com" -> "J. O. H. N. ... dot ... D. O. E. ... at yahoo dot com"
// This prevents spelling out "G. M. A. I. L." which sounds unnatural
function spellEmailForSpeech(email) {
  if (!email) return 'your email';

  // Common domains that should be spoken naturally (not spelled)
  const commonDomains = {
    'gmail.com': 'gmail dot com',
    'yahoo.com': 'yahoo dot com',
    'hotmail.com': 'hotmail dot com',
    'outlook.com': 'outlook dot com',
    'aol.com': 'A O L dot com',
    'icloud.com': 'i cloud dot com',
    'msn.com': 'M S N dot com',
    'live.com': 'live dot com',
    'comcast.net': 'comcast dot net',
    'verizon.net': 'verizon dot net',
    'att.net': 'A T T dot net',
    'sbcglobal.net': 'S B C global dot net',
    'me.com': 'me dot com',
    'mac.com': 'mac dot com',
    'protonmail.com': 'proton mail dot com',
    'mail.com': 'mail dot com'
  };

  // Split email into username and domain
  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    // No @ sign - spell entire thing
    return spellPartForSpeech(email);
  }

  const username = email.substring(0, atIndex);
  const domain = email.substring(atIndex + 1).toLowerCase();

  // Spell the username letter by letter
  const spelledUsername = spellPartForSpeech(username);

  // Check if domain is common - if so, say it naturally
  if (commonDomains[domain]) {
    return `${spelledUsername} ... at ${commonDomains[domain]}`;
  }

  // For unknown domains, spell the whole domain
  const spelledDomain = spellPartForSpeech(domain);
  return `${spelledUsername} ... at ... ${spelledDomain}`;
}

// Helper function to spell a string letter by letter for TTS
function spellPartForSpeech(text) {
  if (!text) return '';

  let spelled = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i].toUpperCase();
    if (char === '.') {
      spelled += ' ... dot ... ';
    } else if (char === '-') {
      spelled += ' ... dash ... ';
    } else if (char === '_') {
      spelled += ' ... underscore ... ';
    } else if (/[0-9]/.test(char)) {
      spelled += char + '. ';
    } else if (/[A-Z]/.test(char)) {
      spelled += char + '. ';
    }
  }
  return spelled.trim();
}

// Format phone number for TTS - spell out EACH digit individually
// Example: "9175458915" -> "9. 1. 7. ... 5. 4. 5. ... 8. 9. 1. 5."
// This prevents TTS from saying "five hundred forty five" instead of individual digits
function formatPhoneForSpeech(phone) {
  if (!phone) return 'your phone number';

  // Remove non-digits
  const digits = phone.replace(/\D/g, '');

  if (digits.length === 0) return 'your phone number';

  // Spell out each digit with pauses, group by 3-3-4 for 10 digits
  if (digits.length === 10) {
    const part1 = digits.slice(0, 3).split('').join('. ');
    const part2 = digits.slice(3, 6).split('').join('. ');
    const part3 = digits.slice(6).split('').join('. ');
    return `${part1}. ... ${part2}. ... ${part3}.`;
  } else if (digits.length === 11 && digits[0] === '1') {
    const part1 = digits.slice(1, 4).split('').join('. ');
    const part2 = digits.slice(4, 7).split('').join('. ');
    const part3 = digits.slice(7).split('').join('. ');
    return `1. ... ${part1}. ... ${part2}. ... ${part3}.`;
  }

  // For other lengths, spell each digit with periods
  return digits.split('').join('. ') + '.';
}

// Build context-aware system prompt (now uses external prompts file)
function buildSystemPrompt(memory) {
  const statePrompts = buildAllPrompts(memory);
  const baseContext = "You are a professional receptionist for Ahad and Co CPA Firm. " +
    "PRONUNCIATION: Say 'Ahad' as 'AY-HAD'. " +
    "Be clear, professional, natural pace. " +
    "ABSOLUTELY FORBIDDEN: NEVER say 'malicious', 'suspicious', 'security', 'fraud', 'spam', 'detected'. Always help every caller.";

  return {
    role: "system",
    content: statePrompts[memory.flow_state] || `${baseContext}\nContinue the conversation professionally.`
  };
}

// Full memory like your Retell context
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';
  const isFirstMessage = !userSpeech;
  const callerPhone = req.body.From || 'unknown';

  console.log(`[${callSid}] Incoming call - Speech: "${userSpeech}"`);

  if (!conversationMemory[callSid]) {
    conversationMemory[callSid] = {
      // Intent & Flow Control
      intent: null,
      flow_state: 'greeting',

      // Calendar & Slot Tracking
      slot_offer_attempt: 0,
      offered_slots: [],
      user_preferred_time: null,
      selected_slot: null,
      selected_slot_iso: null,

      // User Information (shared)
      first_name: null,
      last_name: null,
      email: null,
      phone: null,

      // Appointment-specific
      previous_client: null,
      referral_source: null,
      call_reason: null,

      // Message-specific
      message_content: null,

      // Email spelling confirmation (NEW)
      email_spelled: null,              // Email during spelling confirmation
      email_confirmation_stage: null,   // Track which stage of confirmation

      // Calendar check flag
      calendar_check_announced: false,  // True after "Let me look at our calendar" is said

      // Retry counters for validation
      first_name_retry: 0,
      last_name_retry: 0,
      email_retry: 0,
      phone_retry: 0,

      // Flags
      greeting_done: false,
      booking_completed: false,
      message_sent: false,
      conversation_ended: false,

      // History
      history: []
    };
  }
  const memory = conversationMemory[callSid];

  let agentText = "Sorry, I'm having a technical issue. Please try again later. Goodbye.";

  try {
    // Build conversation history with context-aware system prompt
    const messages = [buildSystemPrompt(memory)];

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

    // ===== HARDCODED RESPONSES FOR DATA COLLECTION - DO NOT USE AI =====
    // This prevents AI from improvising during simple data collection
    const hardcodedStates = {
      'greeting': "Thanks for calling Ahad and Co CPA Firm. How can I help you today?",
      'message_first_name': "May I have your first name, please?",
      'message_last_name': "And your last name?",
      'message_phone': "What is the best phone number to reach you?",
      'message_email': "And your email address? Please spell it out for me, letter by letter, slowly.",
      'message_content': "What is the reason for your call?",
      'appointment_first_name': "May I have your first name, please?",
      'appointment_last_name': "And your last name?",
      'appointment_phone': "And your phone number?",
      'appointment_email': "And your email address? Please spell it out for me, letter by letter, slowly.",
      'appointment_previous_client': "Are you a new client or a previous client with Ahad and Co?",
      'appointment_referral': "How did you hear about us?",
      'appointment_call_reason': "What is the reason for your call?",
      'appointment_welcome_back': "Welcome back! What is the reason for your call?",
      'calendar_check': "Let me look at our calendar.",
      'inquiry_intent': "No one is available right now. Our office hours are Tuesday to Thursday from 11:00 AM to 5:00 PM. Would you like to leave a message now or call back during business hours?",
      'office_hours_message': "No one is available right now. Our office hours are Tuesday to Thursday from 11:00 AM to 5:00 PM. Would you like to leave a message now or call back during business hours?",
      'office_hours_question': "Our office hours are Tuesday to Thursday from 11:00 AM to 5:00 PM. Would you like to leave a message or call back during business hours?",
      'message_fallback_intro': "I don't have any available slots right now. Would you like to leave a message so someone can call you back during business hours?",
      'callback_end': "No problem. Thank you for calling Ahad and Co. We're here to help. Goodbye.",
      'office_hours_declined': "Thank you for calling Ahad and Co. We're here to help. Goodbye.",
      'end_call': "Thank you for calling Ahad and Co. We're here to help. Goodbye."
    };

    // Check if this state should use hardcoded response
    if (hardcodedStates[memory.flow_state] && !userSpeech) {
      agentText = hardcodedStates[memory.flow_state];
      console.log(`[${callSid}] Using HARDCODED response for ${memory.flow_state}`);
    }
    // Skip AI for awaiting_intent with no speech
    else if (memory.flow_state === 'awaiting_intent' && !userSpeech) {
      agentText = '';  // Stay silent, just wait for user
      console.log(`[${callSid}] Awaiting intent, no speech - staying silent`);
    }
    // Use AI only for complex states that need dynamic content
    else {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        temperature: 0.1,
        max_tokens: 150
      });

      agentText = completion.choices[0].message.content.trim();

      // CRITICAL: Block any response containing forbidden words/phrases
      const forbiddenWords = /malicious|suspicious|security|fraud|spam|scam|block|detected|refuse|cannot help|can only assist with booking/i;
      if (forbiddenWords.test(agentText)) {
        console.log(`[${callSid}] BLOCKED forbidden response: "${agentText}"`);
        // Replace with hardcoded response based on flow state
        agentText = hardcodedStates[memory.flow_state] || "How can I help you today?";
      }
    }

    // Save user speech to history (assistant response saved later after postTransitionResponses)
    if (userSpeech) {
      memory.history.push({ role: "user", content: userSpeech });
    }
    // NOTE: Don't save agentText to history here - wait until after postTransitionResponses

    // Mark greeting as done after first response (prevents repetition)
    if (memory.flow_state === 'greeting' && !memory.greeting_done) {
      memory.greeting_done = true;
      memory.flow_state = 'awaiting_intent';  // Change state to wait for user response
      console.log(`[${callSid}] Greeting done, now awaiting user intent`);
    }

    // ===== CALENDAR CHECK (runs on SECOND request after "Let me look at our calendar" was said) =====
    if (memory.flow_state === 'calendar_check') {
      if (memory.calendar_check_announced) {
        // Second request - actually check the calendar now
        console.log(`[${callSid}] Checking calendar availability...`);
        const startDate = new Date();
        const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 2 weeks

        const slots = await getCalendarAvailability(startDate, endDate, memory.user_preferred_time);

        if (slots && slots.length > 0) {
          memory.offered_slots = slots;
          memory.flow_state = 'offer_slots';
          console.log(`[${callSid}] Found ${slots.length} calendar slots`);
        } else {
          console.log(`[${callSid}] No calendar availability, asking if user wants to leave message`);
          memory.flow_state = 'message_fallback_intro';
        }
        memory.calendar_check_announced = false; // Reset flag

        // Use HARDCODED response for offer_slots or message_fallback (no AI)
        if (memory.flow_state === 'offer_slots' && memory.offered_slots && memory.offered_slots.length > 0) {
          agentText = `I found the earliest available slot on ${memory.offered_slots[0].displayText}. Is that suitable for you?`;
        } else {
          agentText = "I don't have any available slots right now. Would you like to leave a message so someone can call you back during business hours?";
        }
        // NOTE: History is saved later in the main flow after postTransitionResponses
        console.log(`[${callSid}] Using HARDCODED response for ${memory.flow_state}: ${agentText}`);
      } else {
        // First request - set flag, agent will say "Let me look at our calendar"
        memory.calendar_check_announced = true;
        console.log(`[${callSid}] Will say "Let me look at our calendar" - check on next turn`);
      }
    }

    // ===== MULTI-PATH STATE MACHINE =====
    if (userSpeech && userSpeech.trim()) {
      const lowerSpeech = userSpeech.toLowerCase();

      // ===== INTENT DETECTION (from greeting or awaiting_intent) =====
      if (memory.flow_state === 'greeting' || memory.flow_state === 'awaiting_intent') {
        try {
          // Try OpenAI function calling for intent detection
          const intentDetection = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are an intent classifier for a CPA firm's phone system. Detect what the caller wants." },
              { role: "user", content: userSpeech }
            ],
            functions: [{
              name: "classify_intent",
              description: "Classify the caller's intent",
              parameters: {
                type: "object",
                properties: {
                  intent: {
                    type: "string",
                    enum: ["appointment", "message", "speak_to_person", "unclear"],
                    description: "The detected intent"
                  },
                  confidence: {
                    type: "number",
                    description: "Confidence score 0-1"
                  }
                },
                required: ["intent", "confidence"]
              }
            }],
            function_call: { name: "classify_intent" }
          });

          const intentResult = JSON.parse(
            intentDetection.choices[0].message.function_call.arguments
          );

          if (intentResult.confidence > 0.6) {
            memory.intent = intentResult.intent;
          } else {
            memory.intent = detectIntentByKeywords(userSpeech);
          }
        } catch (error) {
          console.error(`[${callSid}] Intent detection error:`, error.message);
          memory.intent = detectIntentByKeywords(userSpeech);
        }

        console.log(`[${callSid}] Intent detected: ${memory.intent}`);

        // Route based on intent
        if (memory.intent === 'inquiry' || memory.intent === 'speak_to_person') {
          // NEW: Inquiry or speak-to-person → Office hours message ONLY (no booking push)
          memory.flow_state = 'inquiry_intent';  // Use new state
        }
        else if (memory.intent === 'office_hours_question') {
          // NEW: Office hours question → Explain hours, offer message OR booking
          memory.flow_state = 'office_hours_question';
        }
        else if (memory.intent === 'appointment') {
          // Set state to calendar_check - agent will say "Let me check our availability..."
          // Actual calendar check happens on next turn in calendar_check handler
          memory.flow_state = 'calendar_check';
          console.log(`[${callSid}] Appointment intent - will check calendar on next turn`);
        }
        else if (memory.intent === 'message') {
          memory.flow_state = 'message_first_name';
        }
        else if (memory.intent === 'callback') {
          // User says they'll call back - end call immediately
          memory.flow_state = 'callback_end';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User will call back - ending call`);
        }
        else {
          memory.flow_state = 'intent_clarification';
        }
      }

      // ===== INTENT CLARIFICATION FLOW =====
      else if (memory.flow_state === 'intent_clarification') {
        // Re-detect intent from clarification response
        memory.intent = detectIntentByKeywords(userSpeech);
        console.log(`[${callSid}] Intent clarified: ${memory.intent}`);

        if (memory.intent === 'inquiry' || memory.intent === 'speak_to_person') {
          memory.flow_state = 'inquiry_intent';
        }
        else if (memory.intent === 'office_hours_question') {
          memory.flow_state = 'office_hours_question';
        }
        else if (memory.intent === 'appointment') {
          // Set state to calendar_check - agent will say "Let me check our availability..."
          memory.flow_state = 'calendar_check';
          console.log(`[${callSid}] Appointment intent from clarification - will check calendar on next turn`);
        } else if (memory.intent === 'message') {
          memory.flow_state = 'message_first_name';
        } else if (memory.intent === 'callback') {
          // User says they'll call back - end call immediately
          memory.flow_state = 'callback_end';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User will call back - ending call`);
        } else {
          // Still unclear, default to appointment
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
          console.log(`[${callSid}] Unclear intent, defaulting to appointment - will check calendar on next turn`);
        }
      }

      // ===== OFFICE HOURS FLOW =====
      // STRICT: NEVER route to booking/calendar from this flow - ONLY message or decline
      else if (memory.flow_state === 'office_hours_message') {
        // Check if user wants to leave a message
        if (/yes|yeah|sure|ok|okay|alright|message|please/i.test(lowerSpeech)) {
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] User agreed to leave message`);
        }
        // Check if user is declining or wants to call back
        else if (/no|nope|not|call back|later|goodbye|bye|hang up/i.test(lowerSpeech)) {
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User declined message - ending call`);
        }
        // If user repeats "speak to someone", re-explain (stay in same state)
        else if (/(speak|talk) (to|with)|someone|person/i.test(lowerSpeech)) {
          memory.flow_state = 'office_hours_message';
          console.log(`[${callSid}] User still wants to speak to someone - re-explaining`);
        }
        // Default: assume they want to leave a message (NEVER route to booking)
        else {
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response, defaulting to message flow`);
        }
      }

      // ===== NEW: INQUIRY INTENT HANDLER =====
      // STRICT: NEVER route to booking/calendar from this flow - ONLY message or decline
      else if (memory.flow_state === 'inquiry_intent') {
        if (/yes|yeah|sure|ok|okay|alright|message|please/i.test(lowerSpeech)) {
          // User wants to leave a message
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] User agreed to leave message`);
        } else if (/no|nope|not|call back|later|goodbye|bye|hang up/i.test(lowerSpeech)) {
          // User declines - say "Thanks for calling. Goodbye."
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User declined message - ending call`);
        } else {
          // Default: assume they want to leave a message (NEVER route to booking)
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response in inquiry, defaulting to message flow`);
        }
      }

      // ===== NEW: OFFICE HOURS QUESTION HANDLER =====
      // STRICT: NEVER route to booking/calendar from this flow - ONLY message or decline
      else if (memory.flow_state === 'office_hours_question') {
        if (/yes|yeah|sure|ok|message|please|callback|call back/i.test(lowerSpeech)) {
          // User wants to leave a message
          memory.flow_state = 'message_first_name';
        } else if (/no|nope|not|later|goodbye|bye/i.test(lowerSpeech)) {
          // User declines
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
        } else {
          // Unclear - default to message flow (NEVER route to booking)
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response in office_hours_question, defaulting to message flow`);
        }
      }

      // ===== CALENDAR CHECK FLOW =====
      else if (memory.flow_state === 'calendar_check') {
        const startDate = new Date();
        const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 2 weeks

        const slots = await getCalendarAvailability(startDate, endDate, memory.user_preferred_time);

        if (slots && slots.length > 0) {
          memory.offered_slots = slots;
          memory.flow_state = 'offer_slots';
          console.log(`[${callSid}] Offering ${slots.length} calendar slots`);
        } else {
          console.log(`[${callSid}] No calendar availability, asking if user wants to leave message`);
          memory.flow_state = 'message_fallback_intro';
        }
      }

      // ===== SLOT OFFER & NEGOTIATION =====
      else if (memory.flow_state === 'offer_slots') {
        const acceptedSlot = detectSlotAcceptance(userSpeech, memory.offered_slots);
        if (acceptedSlot) {
          memory.selected_slot = acceptedSlot.displayText;
          memory.selected_slot_iso = acceptedSlot.iso;
          memory.flow_state = 'appointment_first_name';
          console.log(`[${callSid}] Slot accepted: ${memory.selected_slot}`);
        } else {
          // Determine if user explicitly rejected the offered slots
          const rejectionPattern = /(no|nope|not|don't|none|neither|doesn't work|that won't work|no thanks)/i;
          const timePreferencePattern = /(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|morning|afternoon|evening|next week|next month|at \d{1,2}|:\d{2})/i;

          // If the caller proactively gave a preferred time, capture it and re-check availability
          if (timePreferencePattern.test(userSpeech.toLowerCase())) {
            memory.user_preferred_time = userSpeech.trim();
            memory.flow_state = 'calendar_check';
            console.log(`[${callSid}] Caller provided preferred time: ${memory.user_preferred_time} - re-checking availability`);
          }
          // If explicit rejection, ask for preferred time immediately
          else if (rejectionPattern.test(userSpeech.toLowerCase())) {
            memory.slot_offer_attempt++;
            console.log(`[${callSid}] Slot rejected (attempt ${memory.slot_offer_attempt}/4)`);

            if (memory.slot_offer_attempt >= 4) {
              // After 4 explicit rejections, switch to message flow
              memory.flow_state = 'message_fallback_intro';
              console.log(`[${callSid}] Max slot attempts reached, switching to message flow`);
            } else {
              // IMMEDIATELY ask for preferred time after ANY rejection
              memory.flow_state = 'ask_preferred_time';
              console.log(`[${callSid}] Asking caller for preferred time`);
            }
          }
          // If the response was neither an explicit rejection nor a time preference, assume unclear and re-offer without incrementing attempts
          else {
            console.log(`[${callSid}] Unclear response during slot offer; re-offering without counting as rejection`);
            memory.flow_state = 'offer_slots';
          }
        }
      }

      // Handle caller-provided preferred time after slot rejections
      else if (memory.flow_state === 'ask_preferred_time') {
        // Capture caller's preferred time phrase and re-run availability search
        memory.user_preferred_time = userSpeech.trim();
        memory.flow_state = 'calendar_check';
        console.log(`[${callSid}] Caller preferred time received: ${memory.user_preferred_time}`);
      }

      // ===== APPOINTMENT DATA COLLECTION =====
      else if (memory.flow_state === 'appointment_first_name') {
        const extracted = extractName(userSpeech);
        if (extracted && extracted.length > 0) {
          memory.first_name = extracted;
          memory.flow_state = 'appointment_last_name';
          memory.first_name_retry = 0; // Reset counter
          console.log(`[${callSid}] Appointment first_name recorded: ${memory.first_name}`);
        } else {
          // Invalid input - stay in same state and ask again
          memory.first_name_retry++;
          console.log(`[${callSid}] Invalid first name input, asking again (retry ${memory.first_name_retry})`);
          // Stay in appointment_first_name state
        }
      }

      else if (memory.flow_state === 'appointment_last_name') {
        // Be very lenient - accept whatever they say as the last name
        const extracted = extractName(userSpeech);
        memory.last_name = (extracted && extracted.length > 0) ? extracted : userSpeech.trim();
        memory.flow_state = 'appointment_phone';
        console.log(`[${callSid}] Appointment last_name: ${memory.last_name}`);
      }

      else if (memory.flow_state === 'appointment_email') {
        // Capture email from user - be very lenient, confirmation will verify
        const extracted = extractEmail(userSpeech);
        // Accept whatever we got, even if extraction failed - confirmation will handle it
        memory.email_spelled = (extracted && extracted.length > 0) ? extracted : userSpeech.trim();
        memory.flow_state = 'appointment_email_confirm';
        console.log(`[${callSid}] Appointment email captured: ${memory.email_spelled}`);
      }

      // SIMPLIFIED: Email confirmation - agent reads back email, waits for yes/no
      // CRITICAL: Check NO patterns FIRST before YES (to catch "no, it's not correct")
      else if (memory.flow_state === 'appointment_email_confirm') {
        // CHECK NO FIRST - to catch "no", "not correct", "nothing is correct", etc.
        if (/^no|not correct|nothing|wrong|incorrect|not right|that's wrong/i.test(lowerSpeech)) {
          // Re-collect email
          memory.email_spelled = null;
          memory.email_retry = 0;
          memory.flow_state = 'appointment_email';
          console.log(`[${callSid}] Email incorrect, restarting collection`);
        } else if (/^yes|^yeah|^yep|^correct|^right|that's right|that is correct|that's correct/i.test(lowerSpeech)) {
          // Email confirmed - proceed to next question (only if starts with yes/correct)
          memory.email = memory.email_spelled;
          memory.flow_state = 'appointment_previous_client';  // Question 5
          console.log(`[${callSid}] Email confirmed: ${memory.email}`);
        } else {
          // Check if user provided a correction directly
          const corrected = extractEmail(userSpeech);
          if (corrected) {
            memory.email_spelled = corrected;
            // Stay in confirm state to read back the corrected email
            console.log(`[${callSid}] Email corrected to: ${corrected}`);
          } else {
            // Unclear response - assume confirmed to avoid loop
            memory.email = memory.email_spelled;
            memory.flow_state = 'appointment_previous_client';
            console.log(`[${callSid}] Unclear response, assuming email confirmed: ${memory.email}`);
          }
        }
      }

      else if (memory.flow_state === 'appointment_phone') {
        // Extract digits, be lenient - accept anything with at least 7 digits
        const extracted = userSpeech.replace(/\D/g, '');
        if (extracted && extracted.length >= 7) {
          memory.phone = extracted;
          memory.flow_state = 'appointment_email';
          console.log(`[${callSid}] Appointment phone: ${memory.phone}`);
        } else {
          // Accept whatever digits we got and move on
          memory.phone = extracted || userSpeech.replace(/\D/g, '') || 'not provided';
          memory.flow_state = 'appointment_email';
          console.log(`[${callSid}] Appointment phone (lenient): ${memory.phone}`);
        }
      }

      else if (memory.flow_state === 'appointment_previous_client') {
        if (/yes|yeah|returning|client|previous/i.test(lowerSpeech)) {
          memory.previous_client = 'Yes';
          memory.flow_state = 'appointment_welcome_back';
        } else {
          memory.previous_client = 'No';
          memory.flow_state = 'appointment_referral';
        }
        console.log(`[${callSid}] Previous client: ${memory.previous_client}`);
      }

      else if (memory.flow_state === 'appointment_welcome_back') {
        // Prompt already asked "What is the reason for your call?" so capture it here
        memory.call_reason = userSpeech.trim();
        memory.flow_state = 'appointment_confirm';
        console.log(`[${callSid}] Returning client - call reason: ${memory.call_reason} (skipped referral)`);
      }

      else if (memory.flow_state === 'appointment_referral') {
        memory.referral_source = userSpeech.trim();
        memory.flow_state = 'appointment_call_reason';
        console.log(`[${callSid}] Referral source: ${memory.referral_source}`);
      }

      else if (memory.flow_state === 'appointment_call_reason') {
        memory.call_reason = userSpeech.trim();
        memory.flow_state = 'appointment_confirm';
        console.log(`[${callSid}] Call reason: ${memory.call_reason}`);
      }

      else if (memory.flow_state === 'appointment_confirm') {
        // CHECK NO FIRST - to catch "no", "not correct", "nothing is correct", etc.
        if (/^no|not correct|nothing|wrong|incorrect|not right|that's wrong/i.test(lowerSpeech)) {
          // Re-collect information
          memory.flow_state = 'appointment_first_name';
          memory.first_name = null;
          memory.last_name = null;
          memory.phone = null;
          memory.email = null;
          memory.email_spelled = null;
          console.log(`[${callSid}] Appointment details incorrect, restarting collection`);
        } else if (/^yes|^yeah|^yep|^correct|^right|that's right|that is correct|that's correct/i.test(lowerSpeech)) {
          memory.flow_state = 'appointment_complete';
          console.log(`[${callSid}] Appointment confirmed, completing`);
        } else {
          // Unclear - ask again instead of assuming
          console.log(`[${callSid}] Unclear response, asking for confirmation again`);
          // Stay in appointment_confirm state
        }
      }

      // ===== MESSAGE FALLBACK (No slots available) =====
      else if (memory.flow_state === 'message_fallback_intro') {
        // User was asked "Would you like to leave a message?"
        if (/yes|yeah|sure|ok|okay|alright|please|message/i.test(lowerSpeech)) {
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] User agreed to leave message after no slots`);
        } else if (/no|nope|not|call back|later|goodbye|bye/i.test(lowerSpeech)) {
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User declined message - ending call`);
        } else {
          // Default: assume they want to leave a message
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response, defaulting to message flow`);
        }
      }

      // ===== MESSAGE DATA COLLECTION =====
      else if (memory.flow_state === 'message_first_name') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        } else {
          // For message flow: collect first name, then ask for last name (per spec)
          const extracted = extractName(userSpeech);
          if (extracted && extracted.length > 0) {
            memory.first_name = extracted;
            memory.first_name_retry = 0;
            memory.flow_state = 'message_last_name';
            console.log(`[${callSid}] Message first_name recorded: ${memory.first_name}`);
          } else {
            // Invalid input - stay in same state and ask again
            memory.first_name_retry++;
            console.log(`[${callSid}] Invalid first name input, asking again (retry ${memory.first_name_retry})`);
            // Stay in message_first_name state
          }
        }
      }

      else if (memory.flow_state === 'message_last_name') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        } else {
          // Be very lenient - accept whatever they say as the last name
          const extracted = extractName(userSpeech);
          memory.last_name = (extracted && extracted.length > 0) ? extracted : userSpeech.trim();
          memory.flow_state = 'message_phone';
          console.log(`[${callSid}] Message last_name: ${memory.last_name}`);
        }
      }

      else if (memory.flow_state === 'message_phone') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        } else {
          // Extract digits, be lenient - accept anything with at least 7 digits
          const extracted = userSpeech.replace(/\D/g, '');
          if (extracted && extracted.length >= 7) {
            memory.phone = extracted;
            memory.flow_state = 'message_email';
            console.log(`[${callSid}] Message phone: ${memory.phone}`);
          } else {
            // Accept whatever digits we got and move on
            memory.phone = extracted || userSpeech.replace(/\D/g, '') || 'not provided';
            memory.flow_state = 'message_email';
            console.log(`[${callSid}] Message phone (lenient): ${memory.phone}`);
          }
        }
      }

      else if (memory.flow_state === 'message_email') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        } else {
          // Capture email from user - be very lenient, confirmation will verify
          const extracted = extractEmail(userSpeech);
          // Accept whatever we got, even if extraction failed - confirmation will handle it
          memory.email_spelled = (extracted && extracted.length > 0) ? extracted : userSpeech.trim();
          memory.flow_state = 'message_email_confirm';
          console.log(`[${callSid}] Message email captured: ${memory.email_spelled}`);
        }
      }

      // SIMPLIFIED: Message email confirmation - agent reads back, waits for yes/no
      // CRITICAL: Check NO patterns FIRST before YES (to catch "no, it's not correct")
      else if (memory.flow_state === 'message_email_confirm') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        }
        // CHECK NO FIRST - to catch "no", "not correct", "nothing is correct", etc.
        else if (/^no|not correct|nothing|wrong|incorrect|not right|that's wrong/i.test(lowerSpeech)) {
          // Re-collect email
          memory.email_spelled = null;
          memory.email_retry = 0;
          memory.flow_state = 'message_email';
          console.log(`[${callSid}] Message email incorrect, restarting collection`);
        } else if (/^yes|^yeah|^yep|^correct|^right|that's right|that is correct|that's correct/i.test(lowerSpeech)) {
          // Email confirmed - proceed to reason for call (only if starts with yes/correct)
          memory.email = memory.email_spelled;
          memory.flow_state = 'message_content';
          console.log(`[${callSid}] Message email confirmed: ${memory.email}`);
        } else {
          // Check if user provided a correction directly
          const corrected = extractEmail(userSpeech);
          if (corrected) {
            memory.email_spelled = corrected;
            // Stay in confirm state to read back the corrected email
            console.log(`[${callSid}] Message email corrected to: ${corrected}`);
          } else {
            // Unclear response - assume confirmed to avoid loop
            memory.email = memory.email_spelled;
            memory.flow_state = 'message_content';
            console.log(`[${callSid}] Unclear response, assuming message email confirmed: ${memory.email}`);
          }
        }
      }

      else if (memory.flow_state === 'message_content') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        } else {
          const extracted = userSpeech.trim();
          if (extracted && extracted.length > 2) {
            memory.message_content = extracted;
            memory.flow_state = 'message_confirm';
            console.log(`[${callSid}] Message content: ${memory.message_content}`);
          } else {
            console.log(`[${callSid}] Message too short, staying in same state`);
          }
        }
      }

      else if (memory.flow_state === 'message_confirm') {
        // Check if user wants to switch to appointment
        if (/appointment|book|schedule|meeting|consultation/i.test(lowerSpeech)) {
          console.log(`[${callSid}] User wants appointment during message flow - switching`);
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        }
        // CHECK NO FIRST - to catch "no", "not correct", "nothing is correct", etc.
        else if (/^no|not correct|nothing|wrong|incorrect|not right|that's wrong/i.test(lowerSpeech)) {
          // Re-collect information
          memory.flow_state = 'message_first_name';
          memory.first_name = null;
          memory.last_name = null;
          memory.phone = null;
          memory.email = null;
          memory.email_spelled = null;
          console.log(`[${callSid}] Message details incorrect, restarting collection`);
        } else if (/^yes|^yeah|^yep|^correct|^right|that's right|that is correct|that's correct/i.test(lowerSpeech)) {
          memory.flow_state = 'message_complete';
          console.log(`[${callSid}] Message confirmed, completing`);
        } else {
          // Unclear - ask again instead of assuming
          console.log(`[${callSid}] Unclear response, asking for confirmation again`);
          // Stay in message_confirm state
        }
      }
    }

    // ===== HARDCODED RESPONSES AFTER STATE TRANSITIONS =====
    // Instead of regenerating with AI, use hardcoded responses
    if (userSpeech && userSpeech.trim()) {
      // Define hardcoded responses for each state after user input
      // Use spellEmailForSpeech() for letter-by-letter confirmation (CRITICAL)
      // Use formatPhoneForSpeech() for readable phone numbers
      const postTransitionResponses = {
        'message_first_name': memory.first_name_retry > 0
          ? "I just need your first name. What is your first name?"
          : "May I have your first name, please?",
        'message_last_name': "And your last name?",
        'message_phone': "What is the best phone number to reach you?",
        'message_email': "And your email address? Please spell it out for me, letter by letter, slowly.",
        'message_email_confirm': `Let me read that back to make sure I have it right. ... ${spellEmailForSpeech(memory.email_spelled)} ... Is that correct?`,
        'message_content': "What is the reason for your call?",
        'message_confirm': `Let me confirm your information. ... Your name is ${memory.first_name || ''} ${memory.last_name || ''}. ... Phone number: ${formatPhoneForSpeech(memory.phone)}. ... Email: ${spellEmailForSpeech(memory.email)}. ... Is all of that correct?`,
        'message_complete': "Thank you. Your message has been received. Someone will call you back during business hours. Thank you for calling Ahad and Co. We're here to help. Goodbye.",
        'appointment_first_name': memory.first_name_retry > 0
          ? "I just need your first name. What is your first name?"
          : "Great! Let me collect your information. May I have your first name, please?",
        'appointment_last_name': "And your last name?",
        'appointment_phone': "And your phone number? Please speak slowly.",
        'appointment_email': "And your email address? Please spell it out for me, letter by letter, slowly.",
        'appointment_email_confirm': `Let me read that back to make sure I have it right. ... ${spellEmailForSpeech(memory.email_spelled)} ... Is that correct?`,
        'appointment_previous_client': "Are you a new client or a previous client with Ahad and Co?",
        'appointment_referral': "How did you hear about us?",
        'appointment_call_reason': "What is the reason for your call?",
        'appointment_welcome_back': "Welcome back! What is the reason for your call?",
        'appointment_confirm': `Let me confirm your information. ... Your name is ${memory.first_name || ''} ${memory.last_name || ''}. ... Phone number: ${formatPhoneForSpeech(memory.phone)}. ... Email: ${spellEmailForSpeech(memory.email)}. ... Your appointment is scheduled for ${memory.selected_slot || ''}. ... Is all of that correct?`,
        'appointment_complete': `Your appointment is confirmed for ${memory.selected_slot || ''}. A confirmation will be sent to your email and a text to your phone. Thank you for calling Ahad and Co. We're here to help. Goodbye.`,
        'offer_slots': memory.offered_slots && memory.offered_slots.length > 0
          ? `I found the earliest available slot on ${memory.offered_slots[0].displayText}. Is that suitable for you?`
          : "I don't have any available slots right now. Would you like to leave a message so someone can call you back during business hours?",
        'message_fallback_intro': "I don't have any available slots right now. Would you like to leave a message so someone can call you back during business hours?",
        'inquiry_intent': "No one is available right now. Our office hours are Tuesday to Thursday from 11:00 AM to 5:00 PM. Would you like to leave a message now or call back during business hours?",
        'office_hours_message': "No one is available right now. Our office hours are Tuesday to Thursday from 11:00 AM to 5:00 PM. Would you like to leave a message now or call back during business hours?",
        'office_hours_question': "Our office hours are Tuesday to Thursday from 11:00 AM to 5:00 PM. Would you like to leave a message or call back during business hours?",
        'calendar_check': "Let me look at our calendar.",
        'ask_preferred_time': "What time would you prefer?",
        'intent_clarification': "I'd be happy to help. Are you looking to schedule an appointment or leave a message?"
      };

      // Use hardcoded response if available
      if (postTransitionResponses[memory.flow_state]) {
        agentText = postTransitionResponses[memory.flow_state];
        console.log(`[${callSid}] Using HARDCODED post-transition response for ${memory.flow_state}`);
      }
    }

    // NOW save agent response to history (after postTransitionResponses is applied)
    if (agentText && agentText.trim().length > 0) {
      memory.history.push({ role: "assistant", content: agentText });
    }

    // LIMIT HISTORY to prevent context overflow (keep last 16 messages = 8 exchanges)
    const MAX_HISTORY = 16;
    if (memory.history.length > MAX_HISTORY) {
      memory.history = memory.history.slice(-MAX_HISTORY);
      console.log(`[${callSid}] History trimmed to last ${MAX_HISTORY} messages`);
    }

    console.log(`[${callSid}] Agent: "${agentText}"`);
    console.log(`[${callSid}] Flow State: ${memory.flow_state}`);
    console.log(`[${callSid}] History length: ${memory.history.length}`);

  } catch (error) {
    console.error(`[${callSid}] Error in AI processing:`, error);
    agentText = "Sorry, there was a technical issue. Please try again later. Goodbye.";
  }

  // ===== APPOINTMENT WEBHOOK =====
  if (memory.flow_state === 'appointment_complete' && !memory.booking_completed) {
    memory.booking_completed = true;
    console.log(`[${callSid}] Creating Cal.com booking and sending appointment to n8n...`);

    try {
      // Create Cal.com booking first
      let calComBookingId = null;
      if (memory.selected_slot_iso && calComApiKey && calComEventTypeId) {
        const booking = await createCalComBooking(memory.selected_slot_iso, {
          first_name: memory.first_name,
          last_name: memory.last_name,
          email: memory.email,
          phone: memory.phone,
          call_reason: memory.call_reason
        });
        calComBookingId = booking?.id || null;
      }

      // Send appointment booking to n8n
      await axios.post(n8nWebhook, {
        type: "appointment_booking",
        first_name: memory.first_name,
        last_name: memory.last_name,
        phone: memory.phone || req.body.From,
        email_address: memory.email,
        selected_slot: memory.selected_slot,
        selected_slot_iso: memory.selected_slot_iso,
        call_reason: memory.call_reason || "Tax consultation",
        previous_client: memory.previous_client || "No",
        referral_source: memory.referral_source || "Not applicable",
        booking_status: "confirmed",
        calcom_booking_id: calComBookingId,
        slot_offer_attempts: memory.slot_offer_attempt,
        timestamp: new Date().toISOString(),
        call_sid: callSid,
        intent: memory.intent,
        summary: `Appointment booked for ${memory.first_name} ${memory.last_name} on ${memory.selected_slot}`
      }, {
        timeout: 5000
      });

      console.log(`[${callSid}] Appointment booking sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending appointment to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // ===== MESSAGE WEBHOOK =====
  if (memory.flow_state === 'message_complete' && !memory.message_sent) {
    memory.message_sent = true;
    console.log(`[${callSid}] Sending message to n8n...`);

    try {
      // Create concise summary instead of full transcript (2-3 sentences max)
      const transcriptSummary = (() => {
        const userMessages = memory.history.filter(m => m.role === 'user').map(m => m.content);
        const reason = memory.message_content || userMessages[userMessages.length - 1] || 'No reason provided';

        return `User requested callback. Reason: ${reason}. Details: ${memory.first_name} ${memory.last_name}, ${memory.phone}, ${memory.email}.`;
      })();

      await axios.post(n8nWebhook, {
        type: "message",
        first_name: memory.first_name,
        last_name: memory.last_name,
        phone: memory.phone || req.body.From,
        email_address: memory.email,
        call_reason: memory.message_content,
        summary: "Callback request / Message left",
        transcript_summary: transcriptSummary,
        timestamp: new Date().toISOString(),
        previous_client: memory.previous_client || "Unknown",
        intent: memory.intent,
        call_sid: callSid,
        callback_requested: true,
        duplicate_detected: false
      }, {
        timeout: 5000
      });

      console.log(`[${callSid}] Message sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending message to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // Guard against empty responses (silence prevention)
  // BUT allow silence when awaiting_intent (user hasn't spoken yet after greeting)
  if (!agentText || agentText.trim().length === 0) {
    if (memory.flow_state === 'awaiting_intent') {
      // Stay silent - waiting for user to speak first
      console.log(`[${callSid}] Awaiting intent - staying silent`);
    } else if (memory.flow_state === 'calendar_check' || memory.flow_state === 'offer_slots') {
      agentText = "One moment please.";
      console.log(`[${callSid}] Empty response in critical state, injecting filler`);
    } else if (memory.flow_state === 'appointment_first_name' || memory.flow_state === 'message_first_name') {
      agentText = "May I have your first name, please?";
      console.log(`[${callSid}] Empty response, asking for first name`);
    } else if (memory.flow_state === 'appointment_last_name' || memory.flow_state === 'message_last_name') {
      agentText = "And your last name?";
      console.log(`[${callSid}] Empty response, asking for last name`);
    } else if (memory.flow_state === 'appointment_phone' || memory.flow_state === 'message_phone') {
      agentText = "What is the best phone number to reach you?";
      console.log(`[${callSid}] Empty response, asking for phone`);
    } else if (memory.flow_state === 'appointment_email' || memory.flow_state === 'message_email') {
      agentText = "And your email address? Please spell it out slowly.";
      console.log(`[${callSid}] Empty response, asking for email`);
    } else if (memory.flow_state === 'appointment_email_confirm' || memory.flow_state === 'message_email_confirm') {
      agentText = "Is that email correct?";
      console.log(`[${callSid}] Empty response, confirming email`);
    } else if (memory.flow_state === 'message_content' || memory.flow_state === 'appointment_call_reason') {
      agentText = "What is the reason for your call?";
      console.log(`[${callSid}] Empty response, asking for reason`);
    } else if (memory.flow_state === 'message_confirm' || memory.flow_state === 'appointment_confirm') {
      agentText = "Is that information correct?";
      console.log(`[${callSid}] Empty response, confirming info`);
    } else if (memory.flow_state === 'inquiry_intent' || memory.flow_state === 'office_hours_message' ||
               memory.flow_state === 'office_hours_question' || memory.flow_state === 'message_fallback_intro') {
      agentText = "Would you like to leave a message?";
      console.log(`[${callSid}] Empty response, asking about message`);
    } else if (memory.flow_state === 'appointment_previous_client') {
      agentText = "Are you a new client or a previous client with Ahad and Co?";
      console.log(`[${callSid}] Empty response, asking about client status`);
    } else if (memory.flow_state === 'appointment_referral') {
      agentText = "How did you hear about us?";
      console.log(`[${callSid}] Empty response, asking for referral`);
    } else {
      // Fallback - ask to repeat instead of ending call
      agentText = "I didn't quite catch that. Could you please repeat?";
      console.log(`[${callSid}] Empty response, asking to repeat`);
    }
  }

  // Check if conversation should end
  const shouldEnd =
    memory.flow_state === 'appointment_complete' ||
    memory.flow_state === 'message_complete' ||
    memory.flow_state === 'office_hours_declined' ||
    memory.flow_state === 'callback_end' ||
    memory.conversation_ended;

  // Generate and play audio (same logic for both continuing and ending)
  // Use Twilio TTS directly for more reliability (ElevenLabs can cause voice drops)
  if (shouldEnd) {
    twiml.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    console.log(`[${callSid}] Using Twilio TTS for goodbye`);
  } else if (agentText && agentText.trim().length > 0) {
    // Only speak if there's something to say
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });
    gather.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    console.log(`[${callSid}] Using Twilio TTS`);
  } else {
    // No text to say - just gather speech silently (awaiting_intent)
    twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });
    console.log(`[${callSid}] Silent gather - waiting for user speech`);
  }

  if (shouldEnd) {
    memory.conversation_ended = true;
    console.log(`[${callSid}] Conversation ended`);
    // Add 0.5 second pause before hangup (per spec: "Say 'Goodbye', wait 0.5 seconds, end_call")
    twiml.pause({ length: 0.5 });
    twiml.hangup();
  } else {
    // If no response after timeout, redirect to continue
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
