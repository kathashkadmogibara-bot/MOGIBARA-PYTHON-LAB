const EXAMPLES = {
  "Hello World": 'print("Hello, Mogibara!")\n',
  "Input": 'name = input("What is your name? ")\nprint("Hello,", name)\n',
  "For Loop": 'for i in range(1, 6):\n    print("Number:", i)\n',
  "Function": 'def greet(name):\n    return "Hello, " + name\n\nprint(greet("Mogibara"))\n'
};

const $ = id => document.getElementById(id);
const code = $("code"), numbers = $("numbers"), term = $("term");

/* ---------- toast ---------- */
let toastTimer;
function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove("show"), 1800);
}

/* ---------- generic dialog ---------- */
function closeModal(){ $("modal").classList.remove("show"); }
function modal(title, fields, okText, cb, message, danger){
  const box = $("modalBox");
  box.innerHTML = "";
  const h = document.createElement("h3"); h.textContent = title; box.appendChild(h);
  if(message){ const m = document.createElement("div"); m.className = "msg"; m.textContent = message; box.appendChild(m); }
  const els = {};
  fields.forEach(f=>{
    if(f.label){ const l = document.createElement("div"); l.className = "lbl"; l.textContent = f.label; box.appendChild(l); }
    const el = document.createElement(f.area ? "textarea" : "input");
    el.className = "fld" + (f.area ? " area" : "");
    el.value = f.value || "";
    el.placeholder = f.placeholder || "";
    el.spellcheck = false;
    el.setAttribute("autocapitalize","off");
    el.setAttribute("autocomplete","off");
    box.appendChild(el);
    els[f.key] = el;
  });
  const err = document.createElement("div"); err.className = "err"; box.appendChild(err);
  const row = document.createElement("div"); row.className = "row";
  const cancel = document.createElement("button"); cancel.textContent = "Cancel";
  const ok = document.createElement("button"); ok.textContent = okText;
  if(danger) ok.className = "danger";
  cancel.onclick = closeModal;
  ok.onclick = ()=>{
    const vals = {};
    Object.keys(els).forEach(k=>vals[k] = els[k].value);
    const r = cb(vals);
    if(r) err.textContent = r; else closeModal();
  };
  row.appendChild(cancel); row.appendChild(ok); box.appendChild(row);
  $("modal").classList.add("show");
  const first = fields.length ? els[fields[0].key] : null;
  if(first){ setTimeout(()=>{ first.focus(); if(!fields[0].area) first.select(); }, 60); }
}

/* ---------- stored files (inside the app) ---------- */
let memFiles = {};
function getFiles(){
  try{
    const raw = localStorage.getItem("mpl_files");
    if(raw){ memFiles = JSON.parse(raw) || {}; }
  }catch(e){}
  return memFiles;
}
function setFiles(obj){
  memFiles = obj;
  try{ localStorage.setItem("mpl_files", JSON.stringify(obj)); }catch(e){}
}
function cleanName(v){
  v = (v || "").trim();
  if(!v || /[\/\\]/.test(v)) return "";
  if(!/\.[a-z0-9]+$/i.test(v)) v += ".py";
  return v;
}

/* ---------- tabs ---------- */
let tabs = [{name: null, code: "", saved: null}];
let cur = 0;

function label(t){ return t.name ? t.name + (t.code !== t.saved ? "*" : "") : "new*"; }

function renderTabs(){
  const box = $("tabs");
  box.innerHTML = "";
  tabs.forEach((t,i)=>{
    const d = document.createElement("div");
    d.className = "tab" + (i===cur ? " active" : "");
    d.textContent = label(t);
    d.onclick = ()=>switchTab(i);
    box.appendChild(d);
  });
  $("title").textContent = label(tabs[cur]);
  const a = box.querySelector(".active");
  if(a) a.scrollIntoView({inline:"center", block:"nearest"});
}

function updateLabel(){
  $("title").textContent = label(tabs[cur]);
  const a = $("tabs").querySelector(".active");
  if(a) a.textContent = label(tabs[cur]);
}

function switchTab(i){
  tabs[cur].code = code.value;
  cur = i;
  code.value = tabs[cur].code;
  updateLines();
  renderTabs();
}

function newTab(text, name){
  tabs[cur].code = code.value;
  const t = tabs[cur];
  // blank unnamed tab ko reuse karo
  if(!t.name && t.code.trim() === ""){
    tabs[cur] = {name: name || null, code: text || "", saved: name ? (text || "") : null};
  }else{
    tabs.push({name: name || null, code: text || "", saved: name ? (text || "") : null});
    cur = tabs.length - 1;
  }
  code.value = tabs[cur].code;
  updateLines();
  renderTabs();
}

function closeTab(){
  if(tabs.length === 1){ tabs[0] = {name:null, code:"", saved:null}; }
  else { tabs.splice(cur,1); cur = Math.max(0, cur-1); }
  code.value = tabs[cur].code;
  updateLines();
  renderTabs();
}

/* ---------- editor ---------- */
/* ---------- syntax colors ---------- */
const KW = new Set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None".split(" "));
const BI = new Set("print input len range int str float list dict set tuple bool type open abs sum min max sorted reversed enumerate zip map filter round isinstance id any all chr ord format repr hex bin oct pow divmod iter next super object bytes complex frozenset hash help dir vars globals locals callable getattr setattr hasattr eval exec compile slice property staticmethod classmethod Exception ValueError TypeError KeyError IndexError".split(" "));
const TOKEN = /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|(?:[rbfuRBFU]{1,2})?"(?:\\.|[^"\\\n])*(?:"|(?=\n|$))|(?:[rbfuRBFU]{1,2})?'(?:\\.|[^'\\\n])*(?:'|(?=\n|$)))|(#[^\n]*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)/g;

function esc(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function highlight(src){
  let html = "", last = 0, prev = "", m;
  TOKEN.lastIndex = 0;
  while((m = TOKEN.exec(src))){
    html += esc(src.slice(last, m.index));
    const t = m[0];
    let cls = "";
    if(m[1] !== undefined) cls = "s";
    else if(m[2] !== undefined) cls = "c";
    else if(m[3] !== undefined) cls = "n";
    else {
      if(prev === "def" || prev === "class") cls = "f";
      else if(KW.has(t)) cls = "k";
      else if(BI.has(t)) cls = "b";
      prev = t;
    }
    html += cls ? '<span class="'+cls+'">'+esc(t)+'</span>' : esc(t);
    last = m.index + t.length;
    if(t.length === 0) TOKEN.lastIndex++;
  }
  html += esc(src.slice(last));
  return html + "\n";
}

function updateLines(){
  const n = code.value.split("\n").length;
  let s = "";
  for(let i=1;i<=n;i++) s += i + (i<n ? "\n" : "");
  numbers.textContent = s;
  $("hl").innerHTML = highlight(code.value);
  numbers.scrollTop = code.scrollTop;
  $("hl").scrollTop = code.scrollTop;
  $("hl").scrollLeft = code.scrollLeft;
}
function onChange(){
  updateLines();
  tabs[cur].code = code.value;
  updateLabel();
}
code.addEventListener("scroll", ()=>{
  numbers.scrollTop = code.scrollTop;
  $("hl").scrollTop = code.scrollTop;
  $("hl").scrollLeft = code.scrollLeft;
});

function insertText(t, back=0){
  const s = code.selectionStart, e = code.selectionEnd;
  code.setRangeText(t, s, e, "end");
  if(back){ code.selectionStart = code.selectionEnd = code.selectionStart - back; }
  onChange();
  code.focus();
}

const pairs = {"(":")","[":"]","{":"}",'"':'"',"'":"'"};

code.addEventListener("keydown", e=>{
  if((e.ctrlKey||e.metaKey) && e.key==="Enter"){ e.preventDefault(); runCode(); return; }
  if(e.key==="Tab"){ e.preventDefault(); insertText("    "); return; }

});

/* auto brackets / quotes + auto indent
   (beforeinput use kiya hai taaki phone ke keyboard par bhi chale) */
const closers = new Set([")","]","}",'"',"'"]);
let pairHandled = false;

function pairOk(ch, beforeText, next){
  if(next && /\w/.test(next)) return false;
  if(ch === '"' || ch === "'"){
    const w = (beforeText.match(/\w*$/) || [""])[0];
    if(w && !/^[rbfuRBFU]{1,2}$/.test(w)) return false;
  }
  return true;
}

code.addEventListener("beforeinput", e=>{
  pairHandled = false;
  const s = code.selectionStart, en = code.selectionEnd;

  if(e.inputType === "insertText" && e.data && e.data.length === 1 && !e.isComposing){
    const ch = e.data, next = code.value[en];
    if(closers.has(ch) && s === en && next === ch){
      e.preventDefault();
      pairHandled = true;
      code.selectionStart = code.selectionEnd = s + 1;
      return;
    }
    if(pairs[ch] && pairOk(ch, code.value.slice(0,s), next)){
      e.preventDefault();
      pairHandled = true;
      const sel = code.value.slice(s, en);
      code.setRangeText(ch + sel + pairs[ch], s, en, "end");
      code.selectionStart = code.selectionEnd = s + 1 + sel.length;
      onChange();
    }
    return;
  }

  if(e.inputType === "insertLineBreak" || e.inputType === "insertParagraph"){
    const before = code.value.slice(0, s);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    let indent = (line.match(/^\s*/) || [""])[0];
    if(line.trimEnd().endsWith(":")) indent += "    ";
    e.preventDefault();
    pairHandled = true;
    insertText("\n" + indent);
  }
});

code.addEventListener("input", e=>{
  // fallback: agar keyboard ne beforeinput cancel nahi hone diya
  if(!pairHandled && e.data && e.data.length === 1 && pairs[e.data] && e.inputType !== "deleteContentBackward"){
    const s = code.selectionStart;
    if(code.value[s-1] === e.data && pairOk(e.data, code.value.slice(0, s-1), code.value[s])){
      code.setRangeText(pairs[e.data], s, s, "start");
    }
  }
  pairHandled = false;
  onChange();
});

/* ---------- extra keys ---------- */
const KEYS = ["Tab",":",";","'","#","(",")","[","]","{","}",'"',"=","+","-","*","/","%","<",">","_","\\"];
KEYS.forEach(k=>{
  const b = document.createElement("button");
  b.textContent = k;
  b.addEventListener("mousedown", e=>e.preventDefault());
  b.addEventListener("touchstart", e=>e.preventDefault(), {passive:false});
  const act = ()=>{
    if(k==="Tab") insertText("    ");
    else if(pairs[k]) insertText(k+pairs[k],1);
    else insertText(k);
  };
  b.addEventListener("click", act);
  b.addEventListener("touchend", e=>{ e.preventDefault(); act(); });
  $("keys").appendChild(b);
});

/* ---------- copy / download ---------- */
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    toast("Code copy ho gaya");
  }catch(e){
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try{ ok = document.execCommand("copy"); }catch(_){}
    document.body.removeChild(ta);
    toast(ok ? "Code copy ho gaya" : "Copy nahi hua");
  }
}
function downloadText(name, text){
  const blob = new Blob([text], {type:"text/x-python"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name || "main.py";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
  toast("Download: " + (name || "main.py"));
}

/* ---------- save ---------- */
function saveCurrent(asNew){
  tabs[cur].code = code.value;
  const t = tabs[cur];
  if(t.name && !asNew){
    const files = getFiles();
    files[t.name] = t.code;
    setFiles(files);
    t.saved = t.code;
    updateLabel();
    toast("Saved: " + t.name);
    return;
  }
  modal(asNew ? "Save as" : "Save file", [{key:"name", label:"File name", value:t.name || "main.py"}], "Save", v=>{
    const name = cleanName(v.name);
    if(!name) return "Sahi naam likho (/ nahi chalega)";
    const files = getFiles();
    if(files[name] !== undefined && name !== t.name) return "Is naam ki file pehle se hai";
    files[name] = t.code;
    setFiles(files);
    t.name = name;
    t.saved = t.code;
    renderTabs();
    toast("Saved: " + name);
  });
}

/* ---------- menu ---------- */
function toggleMenu(){ $("menu").classList.toggle("show"); $("scrim").classList.toggle("show"); }
function closeMenu(){ $("menu").classList.remove("show"); $("scrim").classList.remove("show"); }

function menuAct(a){
  closeMenu();
  if(a==="new") newTab("");
  else if(a==="files") openFiles();
  else if(a==="save") saveCurrent(false);
  else if(a==="saveas") saveCurrent(true);
  else if(a==="copy") copyText(code.value);
  else if(a==="download") downloadText(tabs[cur].name, code.value);
  else if(a==="close") closeTab();
}

/* ---------- files screen ---------- */
function openFiles(){ renderFiles(); $("filesView").classList.add("show"); }
function closeFiles(){ $("filesView").classList.remove("show"); }

const ICON = {
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z"/></svg>',
  del:  '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>'
};

function renderFiles(){
  const files = getFiles();
  const names = Object.keys(files).sort((a,b)=>a.localeCompare(b));
  const box = $("flist");
  box.innerHTML = "";
  if(!names.length){
    box.innerHTML = '<div class="fempty">Abhi koi file nahi hai.<br>Editor mein code likh kar <b>Save</b> karo, ya upar <b>Paste code</b> se code paste karke file banao.</div>';
    return;
  }
  names.forEach(n=>{
    const lines = files[n].split("\n").length;
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = '<div class="finfo"><div class="fname"></div><div class="fmeta"></div></div>';
    row.querySelector(".fname").textContent = n;
    row.querySelector(".fmeta").textContent = lines + (lines===1 ? " line" : " lines") + " • kholne ke liye tap karo";
    row.querySelector(".finfo").onclick = ()=>openStored(n);
    const mk = (icon, title, fn, cls)=>{
      const b = document.createElement("button");
      b.className = "ib" + (cls ? " " + cls : "");
      b.title = title;
      b.innerHTML = icon;
      b.onclick = fn;
      row.appendChild(b);
    };
    mk(ICON.edit, "Rename", ()=>renameFile(n));
    mk(ICON.copy, "Copy code", ()=>copyText(getFiles()[n]));
    mk(ICON.down, "Download", ()=>downloadText(n, getFiles()[n]));
    mk(ICON.del, "Delete", ()=>deleteFile(n), "del");
    box.appendChild(row);
  });
}

function openStored(name){
  const files = getFiles();
  if(files[name] === undefined) return;
  tabs[cur].code = code.value;
  const idx = tabs.findIndex(t=>t.name === name);
  if(idx >= 0){ switchTab(idx); }
  else { newTab(files[name], name); }
  closeFiles();
}

function renameFile(old){
  modal("Rename file", [{key:"name", label:"Naya naam", value:old}], "Rename", v=>{
    const name = cleanName(v.name);
    if(!name) return "Sahi naam likho (/ nahi chalega)";
    if(name === old) return "";
    const files = getFiles();
    if(files[name] !== undefined) return "Is naam ki file pehle se hai";
    const next = {};
    Object.keys(files).forEach(k=>{ next[k === old ? name : k] = files[k]; });
    setFiles(next);
    tabs.forEach(t=>{ if(t.name === old) t.name = name; });
    renderTabs();
    renderFiles();
    toast("Rename ho gaya");
  });
}

function deleteFile(name){
  modal("Delete file?", [], "Delete", ()=>{
    const files = getFiles();
    delete files[name];
    setFiles(files);
    tabs.forEach(t=>{ if(t.name === name){ t.name = null; t.saved = null; } });
    renderTabs();
    renderFiles();
    toast("Delete ho gaya");
  }, name + " hamesha ke liye delete ho jayegi.", true);
}

function newFileDialog(){
  modal("New file", [{key:"name", label:"File name", value:"main.py"}], "Create", v=>{
    const name = cleanName(v.name);
    if(!name) return "Sahi naam likho (/ nahi chalega)";
    const files = getFiles();
    if(files[name] !== undefined) return "Is naam ki file pehle se hai";
    files[name] = "";
    setFiles(files);
    renderFiles();
    openStored(name);
  });
}

function pasteDialog(){
  modal("Paste code as file", [
    {key:"name", label:"File name", value:"main.py"},
    {key:"text", label:"Code yahan paste karo", value:"", area:true, placeholder:"print('hello')"}
  ], "Create file", v=>{
    const name = cleanName(v.name);
    if(!name) return "Sahi naam likho (/ nahi chalega)";
    const files = getFiles();
    if(files[name] !== undefined) return "Is naam ki file pehle se hai";
    files[name] = v.text;
    setFiles(files);
    renderFiles();
    openStored(name);
  });
}

/* ---------- examples ---------- */
function showExamples(){
  const box = $("dlgBox");
  box.innerHTML = "<h3>Examples</h3>";
  Object.keys(EXAMPLES).forEach(k=>{
    const d = document.createElement("div");
    d.className = "it"; d.textContent = k;
    d.onclick = ()=>{ $("dlg").classList.remove("show"); newTab(EXAMPLES[k]); };
    box.appendChild(d);
  });
  $("dlg").classList.add("show");
}

/* ---------- terminal output ---------- */
const cursorEl = document.createElement("span");
cursorEl.className = "cursor";

function out(t, color){
  let node;
  if(color){ node = document.createElement("span"); node.style.color = color; node.textContent = t; }
  else node = document.createTextNode(t);
  term.insertBefore(node, cursorEl);
  term.scrollTop = term.scrollHeight;
}

const RED = "#ff2d2d", MAGENTA = "#c13bd6";

function showError(text){
  text.split("\n").forEach((line, i, arr)=>{
    const nl = i < arr.length-1 ? "\n" : "";
    if(line === ""){ if(nl) out(nl); return; }
    if(/^Traceback/.test(line)) out(line+nl);
    else if(/^\s*File "/.test(line)) out(line+nl, MAGENTA);
    else if(/^\s*[~^]+\s*$/.test(line)) out(line+nl, MAGENTA);
    else if(/^[A-Za-z_][\w.]*(: .*)?$/.test(line)){
      const m = line.match(/^([A-Za-z_][\w.]*)(: )?(.*)$/);
      out(m[1], MAGENTA);
      if(m[2]) out(m[2]);
      if(m[3]) out(m[3], MAGENTA);
      if(nl) out(nl);
    }
    else out(line+nl, RED);
  });
}

/* ---------- Python runtime (pure JS, no download, no wasm) ---------- */
function closeTerm(){ $("termView").classList.remove("show"); }

function mplInput(promptText){
  if(promptText) out(promptText);
  let a;
  try{ a = prompt("Python input():"); }catch(e){ a = null; }
  if(a === null){
    out("\n[input() dialog isn't available in this preview — download the file and open it in Chrome for full input() support]\n", MAGENTA);
    return "";
  }
  out(a + "\n");
  return a;
}

let running = false;
function runCode(){
  if(running) return;
  running = true;
  tabs[cur].code = code.value;
  term.textContent = "";
  term.appendChild(cursorEl);
  $("termView").classList.add("show");
  try{
    if(typeof MogiPy === "undefined"){
      out("Python engine load nahi hua (interpreter.js missing).\n");
    } else {
      const res = MogiPy.run(code.value, {
        print: t => out(t),
        input: mplInput
      });
      if(!res.ok) showError(res.traceback);
    }
  }catch(err){
    out("\n" + err.message + "\n");
  }
  out("\n[Program finished]");
  running = false;
}

/* ---------- init ---------- */
/* ---------- auto-save session (exit karke wapas aao to bhi code milega) ---------- */
function saveSession(){
  try{
    tabs[cur].code = code.value;
    localStorage.setItem("mpl_session", JSON.stringify({tabs: tabs, cur: cur}));
  }catch(e){}
}
(function restoreSession(){
  try{
    const raw = localStorage.getItem("mpl_session");
    if(!raw) return;
    const d = JSON.parse(raw);
    if(d && Array.isArray(d.tabs) && d.tabs.length){
      tabs = d.tabs;
      cur = Math.min(d.cur || 0, tabs.length - 1);
    }
  }catch(e){}
})();
code.value = tabs[cur].code;
updateLines();
renderTabs();
setInterval(saveSession, 1500);
window.addEventListener("pagehide", saveSession);
document.addEventListener("visibilitychange", function(){ if(document.hidden) saveSession(); });
