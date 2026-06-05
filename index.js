const express = require('express');
const app = express();
app.use(express.json());

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const OWNER_PSID        = process.env.OWNER_PSID;
const PORT              = process.env.PORT || 3000;
const BUFFER_WAIT       = 7000;
const FOLLOWUP_DELAY    = 24 * 60 * 60 * 1000;
const FOLLOWUP_15MIN    = 15 * 60 * 1000;
const FOLLOWUP_1HR      = 60 * 60 * 1000;

const conversations   = new Map();
const clientChecklist = new Map();
const firstMessage    = new Set();
const followupTimers  = new Map();
const followup15Timers = new Map();
const followup1hrTimers = new Map();
const awaitingReply    = new Map(); // psid -> last bot reply timestamp
const pausedChats     = new Set();
const completedChats  = new Set();
const messageBuffer   = new Map();
const processedMsgIds = new Set();
const processingNow   = new Set();

// ── SYSTEM PROMPT ──
const SYSTEM_PROMPT = `Eres Samuel, asesor de Liberty Media, una agencia digital peruana que crea páginas web y tiendas online profesionales.

OBJETIVO ÚNICO: Conseguir el número de teléfono del cliente para llamarle. Nada más.

PERSONALIDAD:
- Mensajes muy cortos — máximo 2 oraciones
- Sin preguntas innecesarias
- Natural, como un mensaje de WhatsApp
- Un emoji si es natural
- NUNCA menciones precios a menos que el cliente pregunte directamente

FLUJO:

1. PRIMER MENSAJE — saluda y pide la llamada directo:
"Hola [nombre si lo tienes], soy Samuel de Liberty Media 👋 Creamos páginas web y tiendas online para negocios. ¿A qué número te llamamos para contarte más?"

2. SI EL CLIENTE PREGUNTA EL PRECIO:
- Web: "Desde S/500, pago único y sin mensualidades."
- Tienda: "Desde S/1,500, con carrito de compras y pagos seguros con tarjeta."
Luego vuelve a pedir el número: "¿A qué número te llamamos?"

3. SI EL CLIENTE PIDE PORTAFOLIO O REFERENCIAS:
"Claro, estos son algunos trabajos: https://vitain.pe/ — https://sanguchoncampesino.pe/ — https://lisoft.edu.pe/ ¿A qué número te llamamos?"

4. SI EL CLIENTE DA EL NÚMERO:
"Perfecto, te llamamos en los próximos minutos."
— DESPUÉS DE ESTO NO RESPONDAS MÁS MENSAJES EN ESTE CHAT —

5. SI EL CLIENTE DICE QUE NO PUEDE AHORA:
"¿A qué hora te viene bien hoy? Te llamamos cuando digas."
Cuando confirme hora: "Perfecto, te llamamos a las [hora]."
— DESPUÉS DE ESTO NO RESPONDAS MÁS MENSAJES EN ESTE CHAT —

REGLAS:
- NUNCA hagas preguntas sobre el negocio, rubro, productos ni objetivos
- NUNCA menciones precios si no te preguntan
- NUNCA envíes mensajes largos ni listas
- NUNCA menciones inteligencia artificial
- Cuando tengas número o hora confirmada: responde una última vez y CIERRA el chat`;

// ── CHECKLIST ──
function getChecklist(psid) {
  if (!clientChecklist.has(psid)) {
    clientChecklist.set(psid, {
      negocio: false, negocioValor: '',
      objetivo: false, objetivoValor: '',
      disponibilidad: false, disponibilidadValor: '',
      numero: false, numeroValor: '',
      nombre: false, nombreValor: '',
      urgencia: 'normal'
    });
  }
  return clientChecklist.get(psid);
}

function isReadyToClose(psid) {
  const c = getChecklist(psid);
  return c.negocio && c.objetivo && c.disponibilidad && c.numero;
}

// ── ACTUALIZAR CHECKLIST ──
function updateChecklist(psid, userMsg) {
  const c = getChecklist(psid);
  const u = userMsg.toLowerCase();
  const val = userMsg.trim();

  const history = conversations.get(psid) || [];
  const botMsgs = history.filter(m => m.role === 'assistant');
  const lastBot = botMsgs.length > 0 ? botMsgs[botMsgs.length - 1].content.toLowerCase() : '';

  if (!c.negocio && (lastBot.includes('dedica') || lastBot.includes('negocio') || botMsgs.length <= 1) && val.length > 1)
    { c.negocio = true; c.negocioValor = val; }

  if (!c.objetivo && (lastBot.includes('necesitas') || lastBot.includes('opcion') || lastBot.includes('tienda') || lastBot.includes('web desde')) && val.length > 2)
    { c.objetivo = true; c.objetivoValor = val; }

  const dias = ['lunes','martes','miércoles','miercoles','jueves','viernes','sábado','sabado','domingo',
    'mañana','tarde','noche','hoy','am','pm',':00',':30','cualquier','disponible'];
  if (!c.disponibilidad && (dias.some(d => u.includes(d)) ||
    (lastBot.includes('10 minutos') || lastBot.includes('llamada') || lastBot.includes('10am')) && val.length > 1))
    { c.disponibilidad = true; c.disponibilidadValor = val; }

  const phoneMatch = userMsg.match(/9\d{8}/);
  const anyDigits = userMsg.match(/\d{6,}/);
  if (!c.numero && (phoneMatch || (anyDigits && (
    lastBot.includes('número') || lastBot.includes('whatsapp') ||
    lastBot.includes('teléfono') || lastBot.includes('llamamos') || lastBot.includes('exacto')
  )))) {
    c.numero = true;
    c.numeroValor = phoneMatch ? phoneMatch[0] : anyDigits[0];
  }

  if (!c.nombre && (lastBot.includes('cómo te llamas') || lastBot.includes('como te llamas')) && val.length > 1 && !/\d/.test(val))
    { c.nombre = true; c.nombreValor = val; }

  if (u.includes('urgente') || u.includes('ahora mismo') || u.includes('lo antes posible'))
    { c.urgencia = 'urgente'; }

  console.log('[' + psid + '] neg=' + c.negocio + ' obj=' + c.objetivo + ' disp=' + c.disponibilidad + ' num=' + c.numero + '(' + c.numeroValor + ')');
}

// ── GPT-4o ──
async function callGPT(psid, userMessage) {
  if (!conversations.has(psid)) conversations.set(psid, []);
  const history = conversations.get(psid);

  history.push({ role: 'user', content: userMessage });
  updateChecklist(psid, userMessage);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-20)],
        max_tokens: 200,
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
    console.error('Error GPT:', err.message);
    return null;
  }
}

// ── ENVIAR MENSAJE ──
async function sendMessage(psid, text) {
  try {
    await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_ACCESS_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { text }, messaging_type: 'RESPONSE' })
    });
  } catch(err) { console.error('Error send:', err.message); }
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
        model: 'gpt-4o-mini', max_tokens: 100, temperature: 0.2,
        messages: [{ role: 'user', content: 'En 2 líneas en español, resume qué necesita este cliente:\n\n' + convText }]
      })
    });
    const d = await res.json();
    resumenIA = d.choices?.[0]?.message?.content?.trim() || '';
  } catch(e) {}

  const notification =
    'NUEVO LEAD (Messenger)' + urgTag + '\n\n' +
    'Nombre: '    + (c.nombreValor        || na) + '\n' +
    'Negocio: '   + (c.negocioValor        || na) + '\n' +
    'Objetivo: '  + (c.objetivoValor       || na) + '\n\n' +
    (resumenIA ? resumenIA + '\n\n' : '') +
    'Llamar al: ' + (c.numeroValor         || 'Ver Messenger') + '\n' +
    'Disponible: '+ (c.disponibilidadValor || na) + '\n' +
    'Facebook: messenger.com/t/' + psid;

  await sendMessage(OWNER_PSID, notification);
  console.log('Lead enviado — ' + now);
}

// ── FOLLOW-UP 15 MIN ──
function schedule15Min(psid) {
  // Cancelar si ya hay uno activo
  if (followup15Timers.has(psid)) clearTimeout(followup15Timers.get(psid));
  if (followup1hrTimers.has(psid)) clearTimeout(followup1hrTimers.get(psid));

  const t15 = setTimeout(async () => {
    followup15Timers.delete(psid);
    if (pausedChats.has(psid) || completedChats.has(psid)) return;
    // Solo si el cliente no ha respondido desde el último mensaje del bot
    const lastReply = awaitingReply.get(psid);
    if (!lastReply) return;
    if (Date.now() - lastReply < FOLLOWUP_15MIN - 5000) return;

    console.log('FOLLOWUP 15min → ' + psid);
    await sendMessage(psid,
      '¿Sigues por ahí? Te llamo ahora mismo si tienes 5 minutos.'
    );
    awaitingReply.set(psid, Date.now());

    // Programar el de 1 hora desde ahora
    schedule1hr(psid);
  }, FOLLOWUP_15MIN);

  followup15Timers.set(psid, t15);
}

function schedule1hr(psid) {
  if (followup1hrTimers.has(psid)) clearTimeout(followup1hrTimers.get(psid));

  const t1hr = setTimeout(async () => {
    followup1hrTimers.delete(psid);
    if (pausedChats.has(psid) || completedChats.has(psid)) return;
    const lastReply = awaitingReply.get(psid);
    if (!lastReply) return;
    if (Date.now() - lastReply < FOLLOWUP_1HR - 5000) return;

    console.log('FOLLOWUP 1hr → ' + psid);
    await sendMessage(psid,
      'Quedamos pendientes. ¿Cuándo te viene bien que te llamemos hoy?'
    );
    awaitingReply.set(psid, null);
  }, FOLLOWUP_1HR);

  followup1hrTimers.set(psid, t1hr);
}

function cancelFollowups(psid) {
  if (followup15Timers.has(psid)) { clearTimeout(followup15Timers.get(psid)); followup15Timers.delete(psid); }
  if (followup1hrTimers.has(psid)) { clearTimeout(followup1hrTimers.get(psid)); followup1hrTimers.delete(psid); }
  awaitingReply.set(psid, null);
}

// ── SEGUIMIENTO 24H ──
function scheduleFollowup(psid) {
  if (followupTimers.has(psid)) clearTimeout(followupTimers.get(psid));
  const timer = setTimeout(async () => {
    if (pausedChats.has(psid) || completedChats.has(psid)) return;
    const conv = conversations.get(psid) || [];
    if (conv.length === 0) return;
    await sendMessage(psid, 'Hola, quedó pendiente tu web. Esta semana tenemos espacio disponible si quieres arrancar. ¿Te llamamos hoy?');
    followupTimers.delete(psid);
  }, FOLLOWUP_DELAY);
  followupTimers.set(psid, timer);
}

// ── PROCESAR BUFFER ──
async function processBuffer(psid) {
  const buf = messageBuffer.get(psid);
  if (!buf || buf.messages.length === 0) return;
  messageBuffer.delete(psid);

  if (processingNow.has(psid)) return;
  processingNow.add(psid);

  try {
    const combinedText = buf.messages.join('. ');
    console.log('\nMensaje de ' + psid + ': ' + combinedText.substring(0, 100));

    // Cliente respondió — cancelar follow-ups pendientes
    cancelFollowups(psid);

    // Post-cierre
    if (completedChats.has(psid)) {
      if (!completedChats.has(psid + '_replied')) {
        completedChats.add(psid + '_replied');
        await new Promise(r => setTimeout(r, 2000));
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

    // Marcar que esperamos respuesta del cliente y activar follow-ups
    awaitingReply.set(psid, Date.now());
    schedule15Min(psid);

    scheduleFollowup(psid);

    // Verificar cierre
    const c = getChecklist(psid);
    const rl = reply.toLowerCase();
    const checklistOk = c.negocio && c.objetivo && c.disponibilidad && c.numero;
    const samuelCerro = rl.includes('te llamamos') || rl.includes('nuestro equipo') ||
      rl.includes('ya tengo todo') || rl.includes('en las próximas') ||
      (rl.includes('perfecto') && (rl.includes('coordinar') || rl.includes('llamar')));

    if (checklistOk && samuelCerro) {
      console.log('CIERRE — ' + psid + ' num=' + c.numeroValor);
      if (followupTimers.has(psid)) { clearTimeout(followupTimers.get(psid)); followupTimers.delete(psid); }
      const conv = conversations.get(psid) || [];
      await notifyOwner(psid, conv);
      completedChats.add(psid);
      conversations.delete(psid);
      clientChecklist.delete(psid);
      firstMessage.delete(psid);
    }
  } finally {
    processingNow.delete(psid);
  }
}

// ── WEBHOOK ──
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(req.query['hub.challenge']);
  } else { res.sendStatus(403); }
});

app.post('/webhook', (req, res) => {
  const body = req.body;
  res.sendStatus(200);
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      if (!psid) continue;
      if (event.sender?.id === event.recipient?.id) continue;

      // Cuando TÚ lees un mensaje del cliente → pausar automáticamente
      // Meta envía read receipt con sender=PAGE cuando el admin lee desde el inbox
      if (event.read && event.sender?.id !== OWNER_PSID) {
        // El dueño leyó el chat del cliente — pausar
        if (!pausedChats.has(psid)) {
          pausedChats.add(psid);
          console.log('AUTO-PAUSADO (read receipt): ' + psid);
        }
        continue;
      }

      if (!event.message) continue;

      // Echos — mensajes que TÚ envías
      if (event.message.is_echo) {
        const clientPsid = event.recipient?.id;
        if (clientPsid && clientPsid !== OWNER_PSID) {
          const echoText = (event.message.text || '').trim();
          if (echoText === '+') {
            pausedChats.delete(clientPsid);
            console.log('Reactivado: ' + clientPsid);
          } else if (echoText.length > 0) {
            if (!pausedChats.has(clientPsid)) {
              pausedChats.add(clientPsid);
              console.log('Pausado: ' + clientPsid);
            }
          }
        }
        continue;
      }

      // Anti-duplicado
      const mid = event.message.mid;
      if (mid) {
        if (processedMsgIds.has(mid)) { console.log('Duplicado ignorado'); continue; }
        processedMsgIds.add(mid);
        if (processedMsgIds.size > 1000) {
          const arr = [...processedMsgIds];
          arr.slice(0, 500).forEach(id => processedMsgIds.delete(id));
        }
        // Limpiar completedChats para evitar memory leak
        if (completedChats.size > 500) {
          const arr = [...completedChats];
          arr.slice(0, 250).forEach(id => completedChats.delete(id));
        }
      }

      if (pausedChats.has(psid)) { console.log('Pausado, ignorado'); continue; }

      let text = event.message.text;
      if (!text && event.message.attachments) {
        const att = event.message.attachments[0];
        if (att?.type === 'image') text = '(imagen enviada)';
        else if (att?.type === 'sticker') continue;
        else continue;
      }
      if (!text) continue;

      // Buffer
      if (!messageBuffer.has(psid)) messageBuffer.set(psid, { messages: [], timer: null });
      const buf = messageBuffer.get(psid);
      if (buf.timer) clearTimeout(buf.timer);
      buf.messages.push(text);
      buf.timer = setTimeout(() => processBuffer(psid).catch(console.error), BUFFER_WAIT);
    }
  }
});

// ── ENDPOINTS DE PAUSA ──
app.get('/', (req, res) => res.send('Liberty Media Messenger Bot activo'));

app.get('/pausa', (req, res) => {
  const { psid, key } = req.query;
  if (key !== VERIFY_TOKEN) return res.status(403).send('No autorizado');
  if (!psid) return res.status(400).send('Falta psid');
  pausedChats.add(psid);
  console.log('PAUSADO via URL: ' + psid);
  res.send('Chat pausado: ' + psid);
});

app.get('/activar', (req, res) => {
  const { psid, key } = req.query;
  if (key !== VERIFY_TOKEN) return res.status(403).send('No autorizado');
  if (!psid) return res.status(400).send('Falta psid');
  pausedChats.delete(psid);
  console.log('REACTIVADO via URL: ' + psid);
  res.send('Chat reactivado: ' + psid);
});

app.get('/pausados', (req, res) => {
  const { key } = req.query;
  if (key !== VERIFY_TOKEN) return res.status(403).send('No autorizado');
  res.send('<h3>Pausados:</h3>' + ([...pausedChats].join('<br>') || 'Ninguno'));
});

app.listen(PORT, () => { console.log('Servidor en puerto ' + PORT); });
