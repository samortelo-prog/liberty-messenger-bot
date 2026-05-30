const express = require('express');
const app = express();
app.use(express.json());

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const OWNER_PSID        = process.env.OWNER_PSID;
const PORT              = process.env.PORT || 3000;

const BUFFER_WAIT    = 7000;  // espera 7s de silencio antes de responder
const FOLLOWUP_DELAY = 24 * 60 * 60 * 1000;

const conversations   = new Map();
const clientChecklist = new Map();
const firstMessage    = new Set();
const followupTimers  = new Map();
const pausedChats     = new Set();
const completedChats  = new Set();
const messageBuffer   = new Map();   // buffer de mensajes agrupados
const processedMsgIds = new Set();   // IDs de mensajes ya procesados (anti-duplicado)
const processingNow   = new Set();   // PSIDs que están siendo procesados ahora mismo

// ── SYSTEM PROMPT ──
const SYSTEM_PROMPT = `Eres Samuel, asesor de Liberty Media, una agencia digital peruana que crea páginas web profesionales.

ROL:
El cliente viene de un anuncio de Facebook — ya mostró interés. Tu trabajo es generar confianza rápido, recolectar los datos clave y agendar la llamada. Este chat es por Messenger — el cliente NO tiene número de teléfono visible, por eso debes pedírselo explícitamente.

PERSONALIDAD:
- Cálido, cercano y profesional
- Natural, sin sonar a formulario ni a robot
- Máximo 2 oraciones por mensaje — breve y directo
- Texto plano sin asteriscos ni markdown
- Un solo emoji cuando sea natural
- CRÍTICO: Lee TODO el historial antes de responder. NUNCA repitas una pregunta que el cliente ya respondió.
- CRÍTICO: Haz UNA sola pregunta por mensaje. Si el cliente manda varios mensajes juntos, respóndelos todos en UN solo mensaje.
- Usa el nombre del cliente cuando lo tengas

EL SERVICIO:
- Páginas web profesionales desde S/500
- Diseño personalizado, responsive, hosting primer año gratis, SSL, textos e imágenes incluidos
- Entrega en 3 a 7 días hábiles

TRABAJOS RECIENTES:
- https://vitain.pe/
- https://sanguchoncampesino.pe/
- https://lisoft.edu.pe/

PREGUNTAS FRECUENTES:
- Precio: "El servicio parte desde S/500. El asesor te dará la propuesta exacta."
- Hosting: "El hosting del primer año está incluido gratis, con SSL y servidor rápido."
- Tiempo: "Entre 3 y 7 días hábiles desde que aprobamos el proyecto."
- "¿Me pueden llamar ahora?": "Claro, coordinaremos para llamarte lo antes posible. Solo necesito unos datos más."
- Dominio o mantenimiento: "El asesor te explicará cuando te llame."

FLUJO — sigue este orden, UNA pregunta a la vez:

1. BIENVENIDA (corto): "Hola, soy Samuel de Liberty Media. ¿A qué se dedica tu negocio?"

2. NOMBRE DEL NEGOCIO: Si solo dijo el rubro, pregunta "¿Y cuál es el nombre de tu negocio?" Si ya dio ambos, salta al objetivo.

3. OBJETIVO: "¿Qué necesitas que haga tu web? Por ejemplo: mostrar tus propiedades, recibir consultas, o que los clientes te contacten." Adapta el ejemplo al rubro.

4. TRABAJOS + LOGO: "Por cierto, aquí algunos trabajos recientes para que veas el nivel: https://vitain.pe/ — https://sanguchoncampesino.pe/ — https://lisoft.edu.pe/ ¿Tienes logo y colores de tu marca?"

5. DISPONIBILIDAD: "¿Qué días y horarios te vienen mejor para que te llamemos?"

6. NÚMERO (CRÍTICO en Messenger): "¿A qué número de WhatsApp o teléfono te llamamos?"
SIEMPRE pide dígitos reales. Si dice "este número" o "el mismo", responde: "Para poder llamarte necesito el número. ¿Cuál es tu WhatsApp o teléfono?"

7. NOMBRE: "¿Y cómo te llamas?"

8. CIERRE — solo cuando tengas negocio, objetivo, disponibilidad y número con dígitos:
"Perfecto [nombre], ya tengo todo. En las próximas horas nuestro equipo te contactará para coordinar los detalles de la web de [negocio]."

REGLAS CRÍTICAS:
- NUNCA repitas una pregunta ya respondida — lee el historial completo
- Si el cliente manda 2 o 3 mensajes seguidos, respóndelos en UN solo mensaje, no varios
- NUNCA uses "este mismo número" — siempre pide dígitos
- NUNCA cierres sin número de teléfono real con dígitos
- NUNCA menciones pagos ni adelantos
- Si manda sticker: ignóralo y continúa
- Nunca menciones inteligencia artificial`;

// ── CHECKLIST ──
function getChecklist(psid) {
  if (!clientChecklist.has(psid)) {
    clientChecklist.set(psid, {
      negocio: false,        negocioValor: '',
      objetivo: false,       objetivoValor: '',
      logo: false,           logoValor: '',
      disponibilidad: false, disponibilidadValor: '',
      numero: false,         numeroValor: '',
      nombre: false,         nombreValor: '',
      urgencia: 'normal'
    });
  }
  return clientChecklist.get(psid);
}

function isReadyToClose(psid) {
  const c = getChecklist(psid);
  return c.negocio && c.objetivo && c.disponibilidad && c.numero;
}

// ── ACTUALIZAR CHECKLIST (usa la pregunta anterior del bot) ──
function updateChecklist(psid, userMsg) {
  const c = getChecklist(psid);
  const u = userMsg.toLowerCase();
  const val = userMsg.trim();

  // El último mensaje del bot en el historial es la pregunta que el cliente acaba de responder
  const history = conversations.get(psid) || [];
  const botMsgs = history.filter(m => m.role === 'assistant');
  const lastBotMsg = botMsgs.length > 0 ? botMsgs[botMsgs.length - 1].content.toLowerCase() : '';

  // NEGOCIO
  if (!c.negocio && (
    lastBotMsg.includes('dedica') || lastBotMsg.includes('nombre de tu negocio') ||
    lastBotMsg.includes('cuál es el nombre') || botMsgs.length <= 1
  ) && val.length > 1)
    { c.negocio = true; c.negocioValor = val; }

  // OBJETIVO
  if (!c.objetivo && (
    lastBotMsg.includes('necesitas que haga') || lastBotMsg.includes('qué necesitas') ||
    lastBotMsg.includes('mostrar tus') || lastBotMsg.includes('recibir consultas')
  ) && val.length > 2)
    { c.objetivo = true; c.objetivoValor = val; }

  // LOGO
  if (!c.logo && (lastBotMsg.includes('logo') || lastBotMsg.includes('colores de tu marca')) && val.length > 1)
    { c.logo = true; c.logoValor = val; }

  // DISPONIBILIDAD
  const dias = ['lunes','martes','miércoles','miercoles','jueves','viernes',
    'sábado','sabado','domingo','mañana','tarde','noche','hoy',
    'am','pm',':00',':30','cualquier','disponible'];
  if (!c.disponibilidad && (
    dias.some(d => u.includes(d)) ||
    lastBotMsg.includes('días y horarios') || lastBotMsg.includes('te vienen mejor') ||
    lastBotMsg.includes('mejor momento') || lastBotMsg.includes('agendamos')
  ) && val.length > 1)
    { c.disponibilidad = true; c.disponibilidadValor = val; }

  // NÚMERO — solo dígitos reales
  const phoneMatch = userMsg.match(/9\d{8}/);
  const anyDigits = userMsg.match(/\d{6,}/);
  if (!c.numero && (phoneMatch || (anyDigits && (
    lastBotMsg.includes('número') || lastBotMsg.includes('whatsapp') ||
    lastBotMsg.includes('teléfono') || lastBotMsg.includes('llamamos')
  )))) {
    c.numero = true;
    c.numeroValor = phoneMatch ? phoneMatch[0] : anyDigits[0];
  }

  // NOMBRE
  if (!c.nombre && (
    lastBotMsg.includes('cómo te llamas') || lastBotMsg.includes('como te llamas') ||
    lastBotMsg.includes('tu nombre')
  ) && val.length > 1 && !/\d/.test(val))
    { c.nombre = true; c.nombreValor = val; }

  // URGENCIA
  if (u.includes('urgente') || u.includes('lo antes posible') || u.includes('ahora mismo') || u.includes('llamar ahora'))
    { c.urgencia = 'urgente'; }

  console.log('[checklist ' + psid + '] neg=' + c.negocio + '(' + c.negocioValor + ')' +
    ' obj=' + c.objetivo + '(' + c.objetivoValor + ')' +
    ' logo=' + c.logo + ' disp=' + c.disponibilidad + '(' + c.disponibilidadValor + ')' +
    ' num=' + c.numero + '(' + c.numeroValor + ')' +
    ' nom=' + c.nombre + '(' + c.nombreValor + ')');
}

// ── LLAMAR A GPT-4o ──
async function callGPT(psid, userMessage) {
  if (!conversations.has(psid)) conversations.set(psid, []);
  const history = conversations.get(psid);

  history.push({ role: 'user', content: userMessage });

  // Actualizar checklist ANTES de generar respuesta (usa la pregunta anterior del bot)
  updateChecklist(psid, userMessage);

  const trimmedHistory = history.slice(-20);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...trimmedHistory
        ],
        max_tokens: 250,
        temperature: 0.6
      })
    });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const botReply = data.choices?.[0]?.message?.content;
    if (!botReply) throw new Error('Respuesta vacía');

    history.push({ role: 'assistant', content: botReply });
    return botReply;

  } catch(err) {
    console.error('Error GPT-4o:', err.message);
    return null;
  }
}

// ── ENVIAR MENSAJE ──
async function sendMessage(psid, text) {
  try {
    const response = await fetch(
      'https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_ACCESS_TOKEN,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text },
          messaging_type: 'RESPONSE'
        })
      }
    );
    if (!response.ok) console.error('Error enviando:', await response.text());
  } catch(err) {
    console.error('Error Messenger API:', err.message);
  }
}

async function sendTyping(psid) {
  try {
    await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_ACCESS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, sender_action: 'typing_on' })
    });
  } catch(e) {}
}

// ── NOTIFICAR AL DUEÑO ──
async function notifyOwner(psid, conv) {
  if (!OWNER_PSID) return;
  const now = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const c = clientChecklist.get(psid) || {};
  const na = 'No especificado';
  const urgTag = c.urgencia === 'urgente' ? ' — URGENTE' : '';

  const convText = conv.map(m => (m.role === 'user' ? 'CLIENTE' : 'SAMUEL') + ': ' + m.content).join('\n');
  let resumenIA = '';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 120,
        temperature: 0.2,
        messages: [{ role: 'user',
          content: 'En máximo 2 líneas en español, resume qué necesita este cliente para su web:\n\n' + convText
        }]
      })
    });
    const d = await res.json();
    resumenIA = d.choices?.[0]?.message?.content?.trim() || '';
  } catch(e) {}

  const notification =
    'NUEVO LEAD (Messenger)' + urgTag + '\n\n' +
    'Nombre: '     + (c.nombreValor        || na) + '\n' +
    'Negocio: '    + (c.negocioValor        || na) + '\n' +
    'Objetivo: '   + (c.objetivoValor       || na) + '\n' +
    'Logo: '       + (c.logoValor           || na) + '\n\n' +
    (resumenIA ? resumenIA + '\n\n' : '') +
    'Llamar al: '  + (c.numeroValor         || 'Ver Messenger') + '\n' +
    'Disponible: ' + (c.disponibilidadValor || na) + '\n' +
    'Facebook: messenger.com/t/' + psid;

  await sendMessage(OWNER_PSID, notification);
  console.log('Lead enviado al dueño — ' + now);
}

// ── SEGUIMIENTO 24H ──
function scheduleFollowup(psid) {
  if (followupTimers.has(psid)) clearTimeout(followupTimers.get(psid));
  const timer = setTimeout(async () => {
    if (pausedChats.has(psid) || isReadyToClose(psid) || completedChats.has(psid)) return;
    const conv = conversations.get(psid) || [];
    if (conv.length === 0) return;
    console.log('Seguimiento a ' + psid);
    await sendMessage(psid, 'Hola, soy Samuel de Liberty Media. Solo quería confirmar si sigues interesado en la web para tu negocio. Estamos disponibles esta semana.');
    followupTimers.delete(psid);
  }, FOLLOWUP_DELAY);
  followupTimers.set(psid, timer);
}

// ── PROCESAR BUFFER (mensajes agrupados) ──
async function processBuffer(psid) {
  const buf = messageBuffer.get(psid);
  if (!buf || buf.messages.length === 0) return;
  messageBuffer.delete(psid);

  // Evitar procesamiento concurrente para el mismo cliente
  if (processingNow.has(psid)) return;
  processingNow.add(psid);

  try {
    const combinedText = buf.messages.join('. ');
    console.log('\nMensaje de ' + psid + ': ' + combinedText.substring(0, 100));

    // Post-cierre: responder una vez y silencio
    if (completedChats.has(psid)) {
      if (!completedChats.has(psid + '_replied')) {
        completedChats.add(psid + '_replied');
        await new Promise(r => setTimeout(r, 2500));
        await sendMessage(psid, 'Con gusto. Pronto tendrás noticias nuestras.');
      }
      return;
    }

    await sendTyping(psid);

    const isFirst = !firstMessage.has(psid);
    if (isFirst) firstMessage.add(psid);
    const thinkTime = isFirst ? 3000 : Math.min(7000 + combinedText.length * 12, 11000);
    await new Promise(r => setTimeout(r, thinkTime));

    const reply = await callGPT(psid, combinedText);
    if (!reply) return;

    await sendMessage(psid, reply);
    console.log('Samuel: ' + reply.substring(0, 100));

    scheduleFollowup(psid);

    // Verificar cierre
    const c = getChecklist(psid);
    const rl = reply.toLowerCase();
    const checklistOk = c.negocio && c.objetivo && c.disponibilidad && c.numero;
    const samuelCerro =
      rl.includes('ya tengo todo') ||
      rl.includes('nuestro equipo te contactar') ||
      rl.includes('en las próximas horas') ||
      (rl.includes('perfecto') && rl.includes('coordinar'));

    if (checklistOk && samuelCerro) {
      console.log('\n===== CIERRE DETECTADO =====');
      console.log('Negocio: ' + c.negocioValor + ' | Num: ' + c.numeroValor);
      console.log('============================\n');
      if (followupTimers.has(psid)) {
        clearTimeout(followupTimers.get(psid));
        followupTimers.delete(psid);
      }
      const conv = conversations.get(psid) || [];
      await notifyOwner(psid, conv);
      completedChats.add(psid);
      conversations.delete(psid);
      clientChecklist.delete(psid);
      firstMessage.delete(psid);
    } else if (checklistOk) {
      console.log('Checklist completo, esperando que Samuel cierre...');
    }
  } finally {
    processingNow.delete(psid);
  }
}

// ── WEBHOOK VERIFICATION ──
app.get('/webhook', (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── RECIBIR MENSAJES ──
app.post('/webhook', (req, res) => {
  const body = req.body;
  res.sendStatus(200);

  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      if (!psid) continue;
      if (event.sender?.id === event.recipient?.id) continue;
      if (!event.message) continue;

      // Anti-duplicado: ignorar mensajes ya procesados
      const mid = event.message.mid;
      if (mid) {
        if (processedMsgIds.has(mid)) {
          console.log('Mensaje duplicado ignorado: ' + mid);
          continue;
        }
        processedMsgIds.add(mid);
        // Limpiar IDs viejos para no crecer infinito
        if (processedMsgIds.size > 1000) {
          const arr = [...processedMsgIds];
          arr.slice(0, 500).forEach(id => processedMsgIds.delete(id));
        }
      }

      // Ignorar echos (mensajes que el bot/página envía)
      if (event.message.is_echo) continue;

      if (pausedChats.has(psid)) {
        console.log('Chat pausado, ignorado: ' + psid);
        continue;
      }

      let text = event.message.text;
      if (!text && event.message.attachments) {
        const att = event.message.attachments[0];
        if (att?.type === 'image') text = '(imagen enviada)';
        else if (att?.type === 'sticker') continue; // ignorar stickers
        else continue;
      }
      if (!text) continue;

      // ── BUFFER: agrupar mensajes que llegan juntos ──
      if (!messageBuffer.has(psid)) {
        messageBuffer.set(psid, { messages: [], timer: null });
      }
      const buf = messageBuffer.get(psid);
      if (buf.timer) clearTimeout(buf.timer);
      buf.messages.push(text);
      buf.timer = setTimeout(() => processBuffer(psid).catch(console.error), BUFFER_WAIT);
    }
  }
});

app.get('/', (req, res) => res.send('Liberty Media Messenger Bot activo'));

app.listen(PORT, () => {
  console.log('Servidor en puerto ' + PORT);
  console.log('Webhook listo en /webhook');
});
