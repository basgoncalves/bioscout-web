/**
 * chat.js -- the Help & chat screen (#viewChat): message list, suggestion
 * chips, the input, and the "Talk to a professional" card.
 *
 * The answers come from help.js; this file only draws them. Everything is
 * built with textContent and createElement, never innerHTML: what goes into
 * the list is what somebody typed, and the answers carry their words back.
 *
 * The conversation lives in memory for this page load and this athlete only.
 * It is not stored and not synced -- a help chat is not part of the training
 * log, and keeping it would mean one more store the privacy note has to
 * account for. Switching athlete starts a fresh conversation.
 */
import { reply, SUGGESTIONS, CONTACT, contactLinks } from "./help.js";

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * `tr` translates; `context()` returns help.js's ctx for the athlete on
 * screen (log, weights, name...) at the moment a question is asked, so an
 * answer always reflects the set recorded a minute ago.
 */
export function makeChat({ tr, context }) {
  const log = document.getElementById("chatLog");
  const chips = document.getElementById("chatChips");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const pro = document.getElementById("chatPro");
  let who = null;

  const scroll = () => {
    log.scrollTop = log.scrollHeight;
    const last = log.lastElementChild;
    if (last && last.scrollIntoView) last.scrollIntoView({ block: "nearest" });
  };

  function bubble(text, mine) {
    const m = el("div", "chatMsg " + (mine ? "me" : "bot"));
    m.appendChild(el("div", "chatWho", tr(mine ? "chat_you" : "chat_bot")));
    m.appendChild(el("div", "chatText", text));
    log.appendChild(m);
    return m;
  }

  function contactCard() {
    const c = el("div", "chatMsg bot chatPro");
    c.appendChild(el("div", "chatProTitle", tr("chat_proTitle")));
    c.appendChild(el("p", "chatText", tr("chat_proBody", { name: CONTACT.name })));
    const links = contactLinks(tr("chat_proSubject"));
    const row = el("div", "chatProLinks");
    const add = (href, label, detail, external) => {
      const a = el("a", "chatProLink");
      a.href = href;
      if (external) { a.target = "_blank"; a.rel = "noopener"; }
      a.appendChild(el("span", "chatProKind", label));
      a.appendChild(el("span", "chatProDetail", detail));
      row.appendChild(a);
    };
    if (links.email) add(links.email, tr("chat_proEmail"), CONTACT.email, false);
    if (links.tel) add(links.tel, tr("chat_proPhone"), CONTACT.phone, false);
    if (links.whatsapp) add(links.whatsapp, tr("chat_proWhatsapp"), CONTACT.phone, true);
    c.appendChild(row);
    c.appendChild(el("p", "chatNote", tr("chat_proMedical")));
    log.appendChild(c);
  }

  function ask(text) {
    const q = String(text || "").trim().slice(0, 500);
    if (!q) return;
    bubble(q, true);
    let r;
    try { r = reply(q, context()); }
    catch (e) { console.warn("chat", e); r = { text: tr("chat_fallback"), contact: true }; }
    bubble(r.text, false);
    if (r.contact) contactCard();
    scroll();
  }

  /* Chips, placeholder and button text: redrawn on open and on a language
   * switch. The messages already in the list stay in the language they were
   * written in, like any chat. */
  function chrome() {
    input.placeholder = tr("chat_placeholder");
    chips.replaceChildren(...SUGGESTIONS.map((s) => {
      const b = el("button", "chip", tr(s.key));
      b.type = "button";
      b.onclick = () => ask(b.textContent);
      return b;
    }));
  }

  function open() {
    const ctx = context();
    if (ctx.profile !== who) {          // a different athlete: a fresh conversation
      who = ctx.profile;
      log.replaceChildren();
    }
    chrome();
    if (!log.children.length) bubble(tr("chat_hello", { name: ctx.name || "" }), false);
    scroll();
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const q = input.value;
    input.value = "";
    ask(q);
  };
  pro.onclick = () => { bubble(tr("chat_contactIntro"), false); contactCard(); scroll(); };

  return { open, chrome, ask };
}
