'use strict';

const chatPanel = find('paper-chat');
const chatLog = find('chat-log');
const chatInput = find('chat-input');
const chatStatus = find('chat-status');
const chatSend = find('chat-send');
const chatToggle = find('open-chat');
let chatHistory = [];
let chatRequest;

function showChatContext() {
  const {code, document: study} = reviewContext();
  const label = find('chat-context');
  const selected = [code, study && study + '.pdf'].filter(Boolean);
  label.textContent = selected.length ? 'Abierto · ' + selected.join(' · ') : '';
  label.hidden = !selected.length;
}

function toggleChat(open) {
  chatPanel.hidden = !open;
  chatToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    showChatContext();
    chatInput.focus();
  } else {
    chatToggle.focus();
  }
}

function renderInline(target, text, available) {
  let offset = 0;
  const inline = /\[(A[0-9]{1,8}),\s*p\.\s*([1-9][0-9]{0,4})\]|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\x60([^\x60\n]+)\x60/g;
  for (const match of text.matchAll(inline)) {
    const [, study, page, label, url, bold, italic, code] = match;
    if (study && !available.has(study + ':' + page)) continue;
    target.append(text.slice(offset, match.index));
    target.append(study ? paperLink(study + ', p. ' + page, './papers/' + study + '.pdf#page=' + page)
      : url ? paperLink(label, url) : bold ? el('strong', bold) : italic ? el('em', italic) : el('code', code));
    offset = match.index + match[0].length;
  }
  target.append(text.slice(offset));
}

function syncChatNodes(target, source) {
  const nextNodes = [...source.childNodes];
  nextNodes.forEach((next, index) => {
    const current = target.childNodes[index];
    if (!current) target.append(next);
    else if (current.nodeName !== next.nodeName) current.replaceWith(next);
    else if (current.nodeType === Node.TEXT_NODE) {
      if (current.data !== next.data) current.data = next.data;
    } else {
      if (current.nodeName === 'A' && current.href !== next.href) current.href = next.href;
      syncChatNodes(current, next);
    }
  });
  while (target.childNodes.length > nextNodes.length) target.lastChild.remove();
}

function renderChatAnswer(target, text, sources = []) {
  const available = new Set(sources.map(([study, page]) => study + ':' + page));
  const content = document.createDocumentFragment();
  let list;
  for (const line of text.split('\n')) {
    const item = line.match(/^\s*(?:[-*]|([0-9]+)\.)\s+(.+)/);
    if (item) {
      const tag = item[1] ? 'ol' : 'ul';
      if (list?.localName !== tag) {
        list = el(tag);
        if (item[1] && item[1] !== '1') list.start = Number(item[1]);
        content.append(list);
      }
      const entry = el('li');
      renderInline(entry, item[2], available);
      list.append(entry);
    } else {
      list = undefined;
      const value = line.trim().replace(/^#{1,6}\s+/, '');
      if (!value || /^[-*#]+$/.test(value)) continue;
      const paragraph = el('p');
      renderInline(paragraph, value, available);
      content.append(paragraph);
    }
  }
  const follow = chatLog.scrollHeight - chatLog.clientHeight - chatLog.scrollTop < 70;
  syncChatNodes(target, content);
  if (follow) chatLog.scrollTop = chatLog.scrollHeight;
}

function answerStream(target) {
  const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let text = '', stops = [], shown = 0, frame = 0, last = 0, credit = 1;

  function paint(now) {
    frame = 0;
    const remaining = stops.length - shown;
    if (last) credit += Math.min(48, now - last) / 1000 * Math.min(110, 18 + remaining * 1.5);
    last = now;
    const amount = Math.min(remaining, Math.floor(credit));
    if (amount) {
      shown += amount;
      credit -= amount;
      renderChatAnswer(target, text.slice(0, stops[shown - 1]));
    }
    if (shown < stops.length) frame = requestAnimationFrame(paint);
    else last = 0;
  }

  function cancel() {
    cancelAnimationFrame(frame);
    frame = 0;
  }

  return {
    update(value) {
      text = value;
      if (!animate || document.hidden) {
        cancel();
        renderChatAnswer(target, text);
        return;
      }
      stops = [];
      const units = /\s+|\[[^\]\n]+\]\((?:https?:\/\/)[^\s)]+\)|\[A[0-9]+,\s*p\.\s*[0-9]+\]|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\x60[^\x60\n]+\x60|[^\s[\x60*]+|[\x60*]/g;
      for (const part of text.matchAll(units)) {
        const end = part.index + part[0].length;
        if (!part[0].trim()) continue;
        if (end === text.length || (/^[\x60*]$/.test(part[0]) && !text.slice(part.index).includes('\n'))) break;
        stops.push(end);
      }
      shown = Math.min(shown, stops.length);
      if (!frame && shown < stops.length) frame = requestAnimationFrame(paint);
    },
    finish(value, sources) {
      cancel();
      renderChatAnswer(target, value, sources);
    },
    cancel
  };
}

async function consumeChat(response, onEvent) {
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'No se pudo iniciar el chat.');
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += value;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('data: ')) onEvent(JSON.parse(frame.slice(6)));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

chatToggle.onclick = () => toggleChat(chatPanel.hidden);
find('chat-close').onclick = () => toggleChat(false);
document.addEventListener('review-context', showChatContext);
chatPanel.onkeydown = event => {
  if (event.key === 'Escape') toggleChat(false);
};
chatInput.onkeydown = event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!chatRequest && chatInput.value.trim()) find('chat-form').requestSubmit();
};
find('chat-reset').onclick = () => {
  chatRequest?.abort();
  chatRequest = undefined;
  chatHistory = [];
  chatStatus.textContent = '';
  chatSend.disabled = false;
  chatLog.replaceChildren(el('p', 'Preguntá por el documento abierto o por cualquier paper.', 'empty'));
  chatInput.value = '';
  chatInput.focus();
};

find('chat-form').onsubmit = async event => {
  event.preventDefault();
  const question = chatInput.value.trim();
  if (!question || chatRequest) return;
  const controller = new AbortController();
  chatRequest = controller;
  const history = chatHistory.slice(-14);
  while (history.reduce((size, message) => size + message.content.length, question.length) > 24000) history.splice(0, 2);
  const message = {role: 'user', content: question};
  const context = reviewContext();
  chatInput.value = '';
  chatSend.disabled = true;
  if (!chatHistory.length) chatLog.querySelector('.empty')?.remove();
  const answer = el('div', undefined, 'chat-answer');
  const renderer = answerStream(answer);
  controller.signal.addEventListener('abort', renderer.cancel, {once: true});
  chatLog.append(el('p', question, 'chat-question'), answer);
  chatLog.scrollTop = chatLog.scrollHeight;
  chatStatus.textContent = 'Preparando la consulta…';
  let done = false;
  try {
    const response = await fetch('./api/chat', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({messages: [...history, message], context}),
      signal: controller.signal
    });
    await consumeChat(response, frame => {
      if (controller !== chatRequest) return;
      if (frame.type === 'status') chatStatus.textContent = frame.text;
      if (frame.type === 'error') throw new Error(frame.text);
      if (frame.type === 'text') {
        chatStatus.textContent = '';
        renderer.update(frame.text);
      }
      if (frame.type === 'done') {
        done = true;
        renderer.finish(frame.text, frame.sources);
        chatHistory.push(message, {role: 'assistant', content: frame.text.slice(0, 8000)});
        chatStatus.textContent = '';
      }
    });
    if (!done) throw new Error('La conexión se cerró antes de completar la respuesta.');
  } catch (error) {
    if (controller === chatRequest) {
      chatStatus.textContent = error.message;
      if (!answer.textContent) answer.remove();
      if (!chatInput.value) chatInput.value = question;
    }
  } finally {
    renderer.cancel();
    if (controller === chatRequest) {
      chatRequest = undefined;
      chatSend.disabled = false;
      if (!chatPanel.hidden) chatInput.focus();
    }
  }
};
