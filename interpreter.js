/* Mogibara mini-Python interpreter — pure JS, no external runtime. */
(function (global) {
"use strict";

/* ========================= ERROR TYPES ========================= */
class PyError extends Error {
  constructor(name, msg, line) {
    super(msg);
    this.pyName = name;
    this.pyMsg = msg;
    this.line = line || null;
  }
}
class BreakSig {}
class ContinueSig {}
class ReturnSig { constructor(v) { this.value = v; } }

/* ========================= NUMBER HELPERS ========================= */
class PyFloat {
  constructor(v) { this.v = v; }
}
function mkFloat(v) { return new PyFloat(v); }
function isFloat(x) { return x instanceof PyFloat; }
function isInt(x) { return typeof x === "number"; }
function isNum(x) { return isInt(x) || isFloat(x); }
function numVal(x) { return isFloat(x) ? x.v : x; }

/* ========================= TUPLE MARKER ========================= */
class PyTuple extends Array {}

/* ========================= LEXER ========================= */
const KEYWORDS = new Set("False None True and as assert break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));

function tokenize(src) {
  const toks = [];
  const lines = src.split("\n");
  let indentStack = [0];
  let bracketDepth = 0;
  let pendingLogicalLine = false;

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    let raw = lines[lineNo];
    let i = 0;
    if (bracketDepth === 0) {
      // measure indentation
      let col = 0;
      while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) {
        col += raw[i] === "\t" ? 8 - (col % 8) : 1;
        i++;
      }
      const rest = raw.slice(i);
      if (rest.trim() === "" || rest.trim().startsWith("#")) {
        continue; // blank/comment-only line: ignore for indentation
      }
      if (col > indentStack[indentStack.length - 1]) {
        indentStack.push(col);
        toks.push({ t: "INDENT", line: lineNo + 1 });
      }
      while (col < indentStack[indentStack.length - 1]) {
        indentStack.pop();
        toks.push({ t: "DEDENT", line: lineNo + 1 });
      }
    }
    // tokenize rest of the physical line starting at i
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === " " || ch === "\t") { i++; continue; }
      if (ch === "#") break; // rest of line is comment
      if (ch === "\\" && i === raw.length - 1) { i++; break; } // line continuation
      // string literal (with optional prefix)
      let prefMatch = /^[rRbBfFuU]{1,2}/.exec(raw.slice(i));
      let prefix = "";
      let qStart = i;
      if (prefMatch && (raw[i + prefMatch[0].length] === '"' || raw[i + prefMatch[0].length] === "'")) {
        prefix = prefMatch[0].toLowerCase();
        qStart = i + prefMatch[0].length;
      }
      if (raw[qStart] === '"' || raw[qStart] === "'") {
        const q = raw[qStart];
        let triple = raw.slice(qStart, qStart + 3) === q + q + q;
        let strVal = "";
        let j = qStart + (triple ? 3 : 1);
        let curLine = lineNo;
        let bufLines = lines;
        let scanLine = raw;
        let closed = false;
        while (true) {
          if (j >= scanLine.length) {
            if (!triple) { break; } // unterminated single-line string
            strVal += "\n";
            curLine++;
            if (curLine >= bufLines.length) break;
            scanLine = bufLines[curLine];
            j = 0;
            continue;
          }
          const c = scanLine[j];
          if (c === "\\" && prefix.indexOf("r") === -1) {
            const nc = scanLine[j + 1];
            const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', "0": "\0" };
            if (nc in map) { strVal += map[nc]; j += 2; continue; }
            strVal += nc === undefined ? "" : nc; j += 2; continue;
          }
          if (c === "\\" && prefix.indexOf("r") !== -1) { strVal += c; j++; continue; }
          if (triple) {
            if (scanLine.slice(j, j + 3) === q + q + q) { j += 3; closed = true; break; }
            strVal += c; j++;
          } else {
            if (c === q) { j++; closed = true; break; }
            strVal += c; j++;
          }
        }
        if (triple && curLine !== lineNo) {
          // advance outer loop past consumed lines
          lineNo = curLine;
          raw = scanLine;
        }
        i = j;
        toks.push({ t: prefix.indexOf("f") !== -1 ? "FSTRING" : "STRING", v: strVal, line: lineNo + 1 });
        continue;
      }
      // numbers
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(raw[i + 1] || ""))) {
        let m = /^\d+\.\d+([eE][+-]?\d+)?|^\d+[eE][+-]?\d+|^\.\d+|^\d+\.(?!\.)|^\d+/.exec(raw.slice(i));
        let text = m[0];
        i += text.length;
        const isFl = text.indexOf(".") !== -1 || /[eE]/.test(text);
        toks.push({ t: "NUMBER", v: isFl ? mkFloat(parseFloat(text)) : parseInt(text, 10), line: lineNo + 1 });
        continue;
      }
      // identifiers / keywords
      if (/[A-Za-z_]/.test(ch)) {
        let m = /^[A-Za-z_]\w*/.exec(raw.slice(i));
        let text = m[0];
        i += text.length;
        if (KEYWORDS.has(text)) toks.push({ t: text, line: lineNo + 1 });
        else toks.push({ t: "NAME", v: text, line: lineNo + 1 });
        continue;
      }
      // operators / punctuation
      const three = raw.slice(i, i + 3);
      const two = raw.slice(i, i + 2);
      const OPS3 = ["**=", "//="];
      const OPS2 = ["**", "//", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "->"];
      if (OPS3.includes(three)) { toks.push({ t: three, line: lineNo + 1 }); i += 3; continue; }
      if (OPS2.includes(two)) { toks.push({ t: two, line: lineNo + 1 }); i += 2; continue; }
      if ("()[]{}".includes(ch)) {
        if ("([{".includes(ch)) bracketDepth++;
        else bracketDepth = Math.max(0, bracketDepth - 1);
        toks.push({ t: ch, line: lineNo + 1 }); i++; continue;
      }
      if (",:.=+-*/%<>!".includes(ch)) { toks.push({ t: ch, line: lineNo + 1 }); i++; continue; }
      // unknown char, skip
      i++;
    }
    if (bracketDepth === 0) {
      toks.push({ t: "NEWLINE", line: lineNo + 1 });
    }
  }
  while (indentStack.length > 1) { indentStack.pop(); toks.push({ t: "DEDENT", line: lines.length }); }
  toks.push({ t: "ENDMARKER", line: lines.length });
  // collapse consecutive NEWLINEs
  const out = [];
  for (const tk of toks) {
    if (tk.t === "NEWLINE" && out.length && out[out.length - 1].t === "NEWLINE") continue;
    if (tk.t === "NEWLINE" && out.length === 0) continue;
    out.push(tk);
  }
  return out;
}

/* ========================= PARSER ========================= */
class Parser {
  constructor(tokens) { this.toks = tokens; this.pos = 0; }
  peek(o) { return this.toks[this.pos + (o || 0)]; }
  at(t) { return this.peek().t === t; }
  advance() { return this.toks[this.pos++]; }
  expect(t) {
    if (!this.at(t)) {
      const got = this.peek();
      throw new PyError("SyntaxError", `expected '${t}' but got '${got.t}'`, got.line);
    }
    return this.advance();
  }
  skipNewlines() { while (this.at("NEWLINE")) this.advance(); }

  parseModule() {
    const body = [];
    this.skipNewlines();
    while (!this.at("ENDMARKER")) {
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    return { type: "Module", body };
  }

  parseBlock() {
    this.expect(":");
    if (this.at("NEWLINE")) {
      this.advance();
      this.skipNewlines();
      this.expect("INDENT");
      const body = [];
      this.skipNewlines();
      while (!this.at("DEDENT")) {
        body.push(this.parseStatement());
        this.skipNewlines();
      }
      this.expect("DEDENT");
      return body;
    } else {
      // single-line suite: if x: y = 1
      const body = [this.parseSimpleStatement()];
      while (this.at(";")) { this.advance(); if (!this.at("NEWLINE")) body.push(this.parseSimpleStatement()); }
      if (this.at("NEWLINE")) this.advance();
      return body;
    }
  }

  parseStatement() {
    const t = this.peek().t;
    if (t === "def") return this.parseFunctionDef();
    if (t === "if") return this.parseIf();
    if (t === "while") return this.parseWhile();
    if (t === "for") return this.parseFor();
    if (t === "try") return this.parseTry();
    if (t === "class") throw new PyError("SyntaxError", "class is not supported in Mogibara Python Lab", this.peek().line);
    const s = this.parseSimpleStatement();
    while (this.at(";")) { this.advance(); if (!this.at("NEWLINE") && !this.at("ENDMARKER")) this.parseSimpleStatement(); }
    if (this.at("NEWLINE")) this.advance();
    return s;
  }

  parseSimpleStatement() {
    const line = this.peek().line;
    const t = this.peek().t;
    if (t === "return") {
      this.advance();
      let value = null;
      if (!this.at("NEWLINE") && !this.at(";") && !this.at("ENDMARKER") && !this.at("DEDENT")) value = this.parseExprList();
      return { type: "Return", value, line };
    }
    if (t === "break") { this.advance(); return { type: "Break", line }; }
    if (t === "continue") { this.advance(); return { type: "Continue", line }; }
    if (t === "pass") { this.advance(); return { type: "Pass", line }; }
    if (t === "import") {
      this.advance();
      const names = [];
      names.push(this.expect("NAME").v);
      while (this.at(",")) { this.advance(); names.push(this.expect("NAME").v); }
      return { type: "Import", names, line };
    }
    if (t === "from") {
      this.advance();
      const mod = this.expect("NAME").v;
      this.expect("import");
      const names = [];
      if (this.at("*")) { this.advance(); names.push("*"); }
      else { names.push(this.expect("NAME").v); while (this.at(",")) { this.advance(); names.push(this.expect("NAME").v); } }
      return { type: "FromImport", mod, names, line };
    }
    if (t === "global" || t === "nonlocal") {
      this.advance();
      const names = [this.expect("NAME").v];
      while (this.at(",")) { this.advance(); names.push(this.expect("NAME").v); }
      return { type: "Global", names, line };
    }
    if (t === "raise") {
      this.advance();
      let exc = null;
      if (!this.at("NEWLINE") && !this.at(";")) exc = this.parseExpr();
      return { type: "Raise", exc, line };
    }
    if (t === "assert") {
      this.advance();
      const test = this.parseExpr();
      let msg = null;
      if (this.at(",")) { this.advance(); msg = this.parseExpr(); }
      return { type: "Assert", test, msg, line };
    }
    if (t === "del") {
      this.advance();
      const target = this.parseExpr();
      return { type: "Del", target, line };
    }
    // expression statement / assignment
    return this.parseExprOrAssign();
  }

  parseExprOrAssign() {
    const line = this.peek().line;
    const first = this.parseExprList();
    if (this.at("=")) {
      const targets = [first];
      let value;
      while (this.at("=")) {
        this.advance();
        const next = this.parseExprList();
        if (this.at("=")) targets.push(next); else value = next;
      }
      return { type: "Assign", targets, value, line };
    }
    const AUG = ["+=", "-=", "*=", "/=", "//=", "%=", "**="];
    if (AUG.includes(this.peek().t)) {
      const op = this.advance().t.slice(0, -1);
      const value = this.parseExprList();
      return { type: "AugAssign", target: first, op, value, line };
    }
    return { type: "ExprStmt", value: first, line };
  }

  parseExprList() {
    // expr (',' expr)* -> tuple if more than one, trailing comma allowed
    const first = this.parseTernary();
    if (this.at(",")) {
      const items = [first];
      while (this.at(",")) {
        this.advance();
        if (this.at("=") || this.at("NEWLINE") || this.at(";") || this.at(")") || this.at("]") || this.at(":") || this.at("ENDMARKER")) break;
        items.push(this.parseTernary());
      }
      return { type: "TupleLit", items, line: first.line };
    }
    return first;
  }

  parseFunctionDef() {
    const line = this.advance().line; // def
    const name = this.expect("NAME").v;
    this.expect("(");
    const params = [];
    let vararg = null, kwarg = null;
    while (!this.at(")")) {
      if (this.at("*")) { this.advance(); vararg = this.expect("NAME").v; }
      else if (this.at("**")) { this.advance(); kwarg = this.expect("NAME").v; }
      else {
        const pname = this.expect("NAME").v;
        let def = null;
        if (this.at("=")) { this.advance(); def = this.parseTernary(); }
        params.push({ name: pname, def });
      }
      if (this.at(",")) this.advance(); else break;
    }
    this.expect(")");
    const body = this.parseBlock();
    return { type: "FunctionDef", name, params, vararg, kwarg, body, line };
  }

  parseIf() {
    const line = this.advance().line; // if
    const test = this.parseExpr();
    const body = this.parseBlock();
    let orelse = [];
    if (this.at("elif")) {
      orelse = [this.parseIfElifAsIf()];
    } else if (this.at("else")) {
      this.advance();
      orelse = this.parseBlock();
    }
    return { type: "If", test, body, orelse, line };
  }
  parseIfElifAsIf() {
    const line = this.advance().line; // elif
    const test = this.parseExpr();
    const body = this.parseBlock();
    let orelse = [];
    if (this.at("elif")) orelse = [this.parseIfElifAsIf()];
    else if (this.at("else")) { this.advance(); orelse = this.parseBlock(); }
    return { type: "If", test, body, orelse, line };
  }

  parseWhile() {
    const line = this.advance().line;
    const test = this.parseExpr();
    const body = this.parseBlock();
    let orelse = [];
    if (this.at("else")) { this.advance(); orelse = this.parseBlock(); }
    return { type: "While", test, body, orelse, line };
  }

  parseFor() {
    const line = this.advance().line;
    const target = this.parseTargetList();
    this.expect("in");
    const iter = this.parseExprList();
    const body = this.parseBlock();
    let orelse = [];
    if (this.at("else")) { this.advance(); orelse = this.parseBlock(); }
    return { type: "For", target, iter, body, orelse, line };
  }

  parseTargetList() {
    const first = this.parsePostfix(this.parseAtom());
    if (this.at(",")) {
      const items = [first];
      while (this.at(",")) {
        this.advance();
        if (this.at("in")) break;
        items.push(this.parsePostfix(this.parseAtom()));
      }
      return { type: "TupleLit", items, line: first.line };
    }
    return first;
  }

  parseTry() {
    const line = this.advance().line;
    const body = this.parseBlock();
    const handlers = [];
    while (this.at("except")) {
      this.advance();
      let exType = null, asName = null;
      if (!this.at(":")) {
        exType = this.parseExpr();
        if (this.at("as")) { this.advance(); asName = this.expect("NAME").v; }
      }
      const hbody = this.parseBlock();
      handlers.push({ exType, asName, body: hbody });
    }
    let orelse = [];
    if (this.at("else")) { this.advance(); orelse = this.parseBlock(); }
    let finalBody = [];
    if (this.at("finally")) { this.advance(); finalBody = this.parseBlock(); }
    return { type: "Try", body, handlers, orelse, finalBody, line };
  }

  /* ---- expressions ---- */
  parseExpr() { return this.parseTernary(); }

  parseTernary() {
    const e = this.parseLambdaOrOr();
    if (this.at("if")) {
      this.advance();
      const test = this.parseOr();
      this.expect("else");
      const orelse = this.parseTernary();
      return { type: "IfExp", test, body: e, orelse, line: e.line };
    }
    return e;
  }
  parseLambdaOrOr() {
    if (this.at("lambda")) {
      const line = this.advance().line;
      const params = [];
      while (!this.at(":")) {
        const pname = this.expect("NAME").v;
        let def = null;
        if (this.at("=")) { this.advance(); def = this.parseTernary(); }
        params.push({ name: pname, def });
        if (this.at(",")) this.advance(); else break;
      }
      this.expect(":");
      const body = this.parseTernary();
      return { type: "Lambda", params, body, line };
    }
    return this.parseOr();
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.at("or")) { const line = this.advance().line; const right = this.parseAnd(); left = { type: "BoolOp", op: "or", left, right, line }; }
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (this.at("and")) { const line = this.advance().line; const right = this.parseNot(); left = { type: "BoolOp", op: "and", left, right, line }; }
    return left;
  }
  parseNot() {
    if (this.at("not")) { const line = this.advance().line; const operand = this.parseNot(); return { type: "UnaryOp", op: "not", operand, line }; }
    return this.parseComparison();
  }
  parseComparison() {
    let left = this.parseBitOr();
    const ops = [];
    const CMP = ["==", "!=", "<", ">", "<=", ">="];
    while (CMP.includes(this.peek().t) || this.at("in") || this.at("not") || this.at("is")) {
      let op;
      if (this.at("not")) { this.advance(); this.expect("in"); op = "not in"; }
      else if (this.at("in")) { this.advance(); op = "in"; }
      else if (this.at("is")) { this.advance(); if (this.at("not")) { this.advance(); op = "is not"; } else op = "is"; }
      else op = this.advance().t;
      const right = this.parseBitOr();
      ops.push({ op, right });
    }
    if (ops.length === 0) return left;
    return { type: "Compare", left, ops, line: left.line };
  }
  parseBitOr() {
    let left = this.parseBitAnd();
    while (this.at("|")) { this.advance(); const right = this.parseBitAnd(); left = { type: "BinOp", op: "|", left, right, line: left.line }; }
    return left;
  }
  parseBitAnd() {
    let left = this.parseAdd();
    while (this.at("&")) { this.advance(); const right = this.parseAdd(); left = { type: "BinOp", op: "&", left, right, line: left.line }; }
    return left;
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.at("+") || this.at("-")) { const op = this.advance().t; const right = this.parseMul(); left = { type: "BinOp", op, left, right, line: left.line }; }
    return left;
  }
  parseMul() {
    let left = this.parseUnary();
    while (["*", "/", "//", "%"].includes(this.peek().t)) { const op = this.advance().t; const right = this.parseUnary(); left = { type: "BinOp", op, left, right, line: left.line }; }
    return left;
  }
  parseUnary() {
    if (this.at("-") || this.at("+") || this.at("~")) { const op = this.advance().t; const operand = this.parseUnary(); return { type: "UnaryOp", op, operand, line: operand.line }; }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix(this.parseAtom());
    if (this.at("**")) { this.advance(); const exp = this.parseUnary(); return { type: "BinOp", op: "**", left: base, right: exp, line: base.line }; }
    return base;
  }

  parsePostfix(atom) {
    let node = atom;
    while (true) {
      if (this.at("(")) {
        this.advance();
        const args = [], kwargs = [];
        while (!this.at(")")) {
          if (this.at("NAME") && this.peek(1).t === "=") {
            const kname = this.advance().v; this.advance();
            kwargs.push({ name: kname, value: this.parseTernary() });
          } else if (this.at("*")) {
            this.advance();
            args.push({ star: true, value: this.parseTernary() });
          } else {
            args.push({ star: false, value: this.parseTernary() });
          }
          if (this.at(",")) this.advance(); else break;
        }
        this.expect(")");
        node = { type: "Call", func: node, args, kwargs, line: node.line };
      } else if (this.at("[")) {
        this.advance();
        // could be index or slice
        let lower = null, upper = null, step = null, isSlice = false;
        if (!this.at(":")) lower = this.at("]") ? null : this.parseTernary();
        if (this.at(":")) {
          isSlice = true; this.advance();
          if (!this.at(":") && !this.at("]")) upper = this.parseTernary();
          if (this.at(":")) { this.advance(); if (!this.at("]")) step = this.parseTernary(); }
        }
        this.expect("]");
        if (isSlice) node = { type: "Slice", obj: node, lower, upper, step, line: node.line };
        else node = { type: "Subscript", obj: node, index: lower, line: node.line };
      } else if (this.at(".")) {
        this.advance();
        const name = this.expect("NAME").v;
        node = { type: "Attribute", obj: node, attr: name, line: node.line };
      } else break;
    }
    return node;
  }

  parseAtom() {
    const tk = this.peek();
    if (tk.t === "NUMBER") { this.advance(); return { type: "Num", value: tk.v, line: tk.line }; }
    if (tk.t === "STRING") {
      this.advance();
      let s = tk.v;
      while (this.at("STRING") || this.at("FSTRING")) {
        // implicit string concat "a" "b"
        const nxt = this.advance();
        if (nxt.t === "FSTRING") { return { type: "FString", raw: s + "{}".replace("{}", "") , parts: null, concatFollow: nxt, line: tk.line }; }
        s += nxt.v;
      }
      return { type: "Str", value: s, line: tk.line };
    }
    if (tk.t === "FSTRING") { this.advance(); return { type: "FString", raw: tk.v, line: tk.line }; }
    if (tk.t === "True") { this.advance(); return { type: "Bool", value: true, line: tk.line }; }
    if (tk.t === "False") { this.advance(); return { type: "Bool", value: false, line: tk.line }; }
    if (tk.t === "None") { this.advance(); return { type: "NoneLit", line: tk.line }; }
    if (tk.t === "NAME") { this.advance(); return { type: "Name", id: tk.v, line: tk.line }; }
    if (tk.t === "(") {
      this.advance();
      if (this.at(")")) { this.advance(); return { type: "TupleLit", items: [], line: tk.line }; }
      const first = this.parseTernary();
      if (this.at(",")) {
        const items = [first];
        while (this.at(",")) { this.advance(); if (this.at(")")) break; items.push(this.parseTernary()); }
        this.expect(")");
        return { type: "TupleLit", items, line: tk.line };
      }
      if (this.at("for")) {
        const comp = this.parseCompTail(first, tk.line);
        this.expect(")");
        return { type: "GenExp", ...comp, line: tk.line };
      }
      this.expect(")");
      return first;
    }
    if (tk.t === "[") {
      this.advance();
      if (this.at("]")) { this.advance(); return { type: "ListLit", items: [], line: tk.line }; }
      const first = this.parseTernary();
      if (this.at("for")) {
        const comp = this.parseCompTail(first, tk.line);
        this.expect("]");
        return { type: "ListComp", ...comp, line: tk.line };
      }
      const items = [first];
      while (this.at(",")) { this.advance(); if (this.at("]")) break; items.push(this.parseTernary()); }
      this.expect("]");
      return { type: "ListLit", items, line: tk.line };
    }
    if (tk.t === "{") {
      this.advance();
      if (this.at("}")) { this.advance(); return { type: "DictLit", items: [], line: tk.line }; }
      const firstKey = this.parseTernary();
      if (this.at(":")) {
        this.advance();
        const firstVal = this.parseTernary();
        if (this.at("for")) {
          const comp = this.parseCompTail(null, tk.line, { key: firstKey, val: firstVal });
          this.expect("}");
          return { type: "DictComp", ...comp, line: tk.line };
        }
        const items = [{ key: firstKey, value: firstVal }];
        while (this.at(",")) {
          this.advance(); if (this.at("}")) break;
          const k = this.parseTernary(); this.expect(":"); const v = this.parseTernary();
          items.push({ key: k, value: v });
        }
        this.expect("}");
        return { type: "DictLit", items, line: tk.line };
      } else {
        // set literal
        if (this.at("for")) {
          const comp = this.parseCompTail(firstKey, tk.line);
          this.expect("}");
          return { type: "SetComp", ...comp, line: tk.line };
        }
        const items = [firstKey];
        while (this.at(",")) { this.advance(); if (this.at("}")) break; items.push(this.parseTernary()); }
        this.expect("}");
        return { type: "SetLit", items, line: tk.line };
      }
    }
    throw new PyError("SyntaxError", `unexpected token '${tk.t}'`, tk.line);
  }

  parseCompTail(elt, line, dictPair) {
    this.expect("for");
    const target = this.parseTargetList();
    this.expect("in");
    const iter = this.parseOr();
    let ifs = [];
    while (this.at("if")) { this.advance(); ifs.push(this.parseOr()); }
    return dictPair
      ? { key: dictPair.key, val: dictPair.val, target, iter, ifs }
      : { elt, target, iter, ifs };
  }
}

/* parse f-string raw text into list of {lit} / {expr} parts */
function parseFStringParts(raw) {
  const parts = [];
  let i = 0, buf = "";
  while (i < raw.length) {
    const c = raw[i];
    if (c === "{" && raw[i + 1] === "{") { buf += "{"; i += 2; continue; }
    if (c === "}" && raw[i + 1] === "}") { buf += "}"; i += 2; continue; }
    if (c === "{") {
      if (buf) { parts.push({ lit: buf }); buf = ""; }
      let depth = 1, j = i + 1, exprSrc = "";
      let fmtSpec = "";
      while (j < raw.length && depth > 0) {
        if (raw[j] === "{") depth++;
        else if (raw[j] === "}") { depth--; if (depth === 0) break; }
        exprSrc += raw[j]; j++;
      }
      j++; // skip closing }
      // handle !r/!s and :spec (very basic, split at top-level ':' not inside brackets)
      let conv = null;
      let bang = exprSrc.lastIndexOf("!");
      let colonIdx = -1, bd = 0;
      for (let k = 0; k < exprSrc.length; k++) {
        if ("([{".includes(exprSrc[k])) bd++;
        else if (")]}".includes(exprSrc[k])) bd--;
        else if (exprSrc[k] === ":" && bd === 0) { colonIdx = k; break; }
      }
      if (colonIdx !== -1) { fmtSpec = exprSrc.slice(colonIdx + 1); exprSrc = exprSrc.slice(0, colonIdx); }
      parts.push({ expr: exprSrc.trim(), fmt: fmtSpec });
      i = j;
      continue;
    }
    buf += c; i++;
  }
  if (buf) parts.push({ lit: buf });
  return parts;
}

/* ========================= INTERPRETER ========================= */
class Scope {
  constructor(parent) { this.vars = new Map(); this.parent = parent; }
  get(name) {
    let s = this;
    while (s) { if (s.vars.has(name)) return s.vars.get(name); s = s.parent; }
    return undefined;
  }
  has(name) {
    let s = this;
    while (s) { if (s.vars.has(name)) return true; s = s.parent; }
    return false;
  }
  setExisting(name, val) {
    let s = this;
    while (s) { if (s.vars.has(name)) { s.vars.set(name, val); return true; } s = s.parent; }
    return false;
  }
  setLocal(name, val) { this.vars.set(name, val); }
}

class PyFunction {
  constructor(name, params, vararg, kwarg, body, closure) {
    this.name = name; this.params = params; this.vararg = vararg; this.kwarg = kwarg;
    this.body = body; this.closure = closure;
  }
}
class BoundMethod {
  constructor(self, fn) { this.self = self; this.fn = fn; }
}
class BuiltinFn {
  constructor(name, fn) { this.name = name; this.fn = fn; }
}

const NONE = Object.freeze({ __none__: true });

function truthy(v) {
  if (v === NONE || v === undefined) return false;
  if (v === true || v === false) return v;
  if (isFloat(v)) return v.v !== 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (v instanceof Set) return v.size > 0;
  return true;
}

function typeName(v) {
  if (v === NONE || v === undefined) return "NoneType";
  if (v === true || v === false) return "bool";
  if (isFloat(v)) return "float";
  if (typeof v === "number") return "int";
  if (typeof v === "string") return "str";
  if (v instanceof PyTuple) return "tuple";
  if (Array.isArray(v)) return "list";
  if (v instanceof Map) return "dict";
  if (v instanceof Set) return "set";
  if (v instanceof PyFunction || v instanceof BuiltinFn || v instanceof BoundMethod) return "function";
  return "object";
}

function pyRepr(v) {
  if (v === NONE || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (isFloat(v)) return formatFloat(v.v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const hasS = v.indexOf("'") !== -1, hasD = v.indexOf('"') !== -1;
    const q = hasS && !hasD ? '"' : "'";
    let esc = v.replace(/\\/g, "\\\\");
    if (q === "'") esc = esc.replace(/'/g, "\\'"); else esc = esc.replace(/"/g, '\\"');
    esc = esc.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
    return q + esc + q;
  }
  if (v instanceof PyTuple) {
    const inner = Array.from(v).map(pyRepr).join(", ");
    return v.length === 1 ? "(" + inner + ",)" : "(" + inner + ")";
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof Map) {
    const items = [];
    for (const [k, val] of v.entries()) items.push(pyRepr(k) + ": " + pyRepr(val));
    return "{" + items.join(", ") + "}";
  }
  if (v instanceof Set) {
    if (v.size === 0) return "set()";
    return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
  }
  if (v instanceof PyFunction) return `<function ${v.name}>`;
  if (v instanceof BuiltinFn) return `<built-in function ${v.name}>`;
  return String(v);
}

function formatFloat(n) {
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isNaN(n)) return "nan";
  if (Number.isInteger(n)) {
    if (Math.abs(n) >= 1e16) return n.toExponential().replace("e+", "e+0").replace(/e\+?(-?)0*(\d)/, "e$1$2");
    return n.toFixed(1);
  }
  let s = String(n);
  if (s.indexOf("e") !== -1) return s;
  return s;
}

function pyStr(v) {
  if (typeof v === "string") return v;
  return pyRepr(v);
}

/* ========================= Interpreter core ========================= */
class Interpreter {
  constructor(opts) {
    this.print = opts.print || (() => {});
    this.input = opts.input || (() => "");
    this.srcLines = opts.srcLines || [];
    this.global = new Scope(null);
    this.installBuiltins();
  }

  err(name, msg, line) { throw new PyError(name, msg, line); }

  installBuiltins() {
    const g = this.global;
    const self = this;
    const B = (name, fn) => g.setLocal(name, new BuiltinFn(name, fn));

    B("print", (args, kwargs) => {
      const sep = kwargs.sep !== undefined ? kwargs.sep : " ";
      const end = kwargs.end !== undefined ? kwargs.end : "\n";
      self.print(args.map(pyStr).join(sep) + end);
      return NONE;
    });
    B("input", (args) => {
      const p = args.length ? pyStr(args[0]) : "";
      return self.input(p);
    });
    B("len", (args) => {
      const v = args[0];
      if (typeof v === "string" || Array.isArray(v)) return v.length;
      if (v instanceof Map || v instanceof Set) return v.size;
      self.err("TypeError", `object of type '${typeName(v)}' has no len()`);
    });
    B("range", (args) => {
      let start = 0, stop, step = 1;
      const nums = args.map(numVal);
      if (nums.length === 1) stop = nums[0];
      else if (nums.length === 2) { start = nums[0]; stop = nums[1]; }
      else { start = nums[0]; stop = nums[1]; step = nums[2]; }
      if (step === 0) self.err("ValueError", "range() arg 3 must not be zero");
      const out = [];
      if (step > 0) for (let i = start; i < stop; i += step) out.push(i);
      else for (let i = start; i > stop; i += step) out.push(i);
      out.__isRange = true;
      return out;
    });
    B("str", (args) => (args.length ? pyStr(args[0]) : ""));
    B("repr", (args) => pyRepr(args[0]));
    B("int", (args) => {
      if (!args.length) return 0;
      const v = args[0];
      if (typeof v === "string") {
        const t = v.trim();
        if (!/^[+-]?\d+$/.test(t)) self.err("ValueError", `invalid literal for int() with base 10: ${pyRepr(v)}`);
        return parseInt(t, 10);
      }
      if (typeof v === "number") return Math.trunc(v);
      if (isFloat(v)) return Math.trunc(v.v);
      if (v === true) return 1; if (v === false) return 0;
      self.err("TypeError", `int() argument must be a string or a number, not '${typeName(v)}'`);
    });
    B("float", (args) => {
      if (!args.length) return mkFloat(0);
      const v = args[0];
      if (typeof v === "string") {
        const t = v.trim();
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) self.err("ValueError", `could not convert string to float: ${pyRepr(v)}`);
        return mkFloat(parseFloat(t));
      }
      if (typeof v === "number") return mkFloat(v);
      if (isFloat(v)) return v;
      if (v === true) return mkFloat(1); if (v === false) return mkFloat(0);
      self.err("TypeError", `float() argument must be a string or a number, not '${typeName(v)}'`);
    });
    B("bool", (args) => (args.length ? truthy(args[0]) : false));
    B("list", (args) => {
      if (!args.length) return [];
      return Array.from(iterate(self, args[0]));
    });
    B("tuple", (args) => {
      if (!args.length) return new PyTuple();
      return PyTuple.from(iterate(self, args[0]));
    });
    B("set", (args) => {
      if (!args.length) return new Set();
      return new Set(Array.from(iterate(self, args[0])).map(canonKey));
    });
    B("dict", (args, kwargs) => {
      const m = new Map();
      if (args.length) {
        for (const item of iterate(self, args[0])) {
          const pair = Array.from(iterate(self, item));
          m.set(canonKey(pair[0]), pair[1]);
        }
      }
      for (const k in kwargs) m.set(k, kwargs[k]);
      return m;
    });
    B("abs", (args) => {
      const v = args[0];
      if (isFloat(v)) return mkFloat(Math.abs(v.v));
      return Math.abs(v);
    });
    B("round", (args) => {
      const v = numVal(args[0]);
      if (args.length > 1) {
        const nd = numVal(args[1]);
        const f = Math.pow(10, nd);
        return mkFloat(Math.round(v * f) / f);
      }
      const r = Math.round(v);
      // Python banker's rounding approx skipped for simplicity
      return r;
    });
    B("sum", (args) => {
      const items = Array.from(iterate(self, args[0]));
      let acc = args.length > 1 ? args[1] : 0;
      for (const it of items) acc = binOp("+", acc, it, self);
      return acc;
    });
    B("min", (args) => reduceMinMax(self, args, -1));
    B("max", (args) => reduceMinMax(self, args, 1));
    B("sorted", (args, kwargs) => {
      const items = Array.from(iterate(self, args[0]));
      const rev = truthy(kwargs.reverse);
      const keyFn = kwargs.key;
      const decorated = items.map((it) => [keyFn ? self.callFunction(keyFn, [it], {}) : it, it]);
      decorated.sort((a, b) => compareVals(a[0], b[0]));
      if (rev) decorated.reverse();
      return decorated.map((p) => p[1]);
    });
    B("reversed", (args) => Array.from(iterate(self, args[0])).reverse());
    B("enumerate", (args) => {
      const start = args.length > 1 ? numVal(args[1]) : 0;
      const items = Array.from(iterate(self, args[0]));
      return items.map((it, i) => PyTuple.from([start + i, it]));
    });
    B("zip", (args) => {
      const lists = args.map((a) => Array.from(iterate(self, a)));
      const len = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
      const out = [];
      for (let i = 0; i < len; i++) out.push(PyTuple.from(lists.map((l) => l[i])));
      return out;
    });
    B("map", (args) => {
      const fn = args[0];
      const items = Array.from(iterate(self, args[1]));
      return items.map((it) => self.callFunction(fn, [it], {}));
    });
    B("filter", (args) => {
      const fn = args[0];
      const items = Array.from(iterate(self, args[1]));
      return items.filter((it) => truthy(fn === NONE ? it : self.callFunction(fn, [it], {})));
    });
    B("type", (args) => typeName(args[0]));
    B("isinstance", (args) => {
      const tn = typeName(args[0]);
      const want = args[1];
      const wants = Array.isArray(want) || want instanceof PyTuple ? Array.from(want) : [want];
      return wants.some((w) => typeName.toString && String(w) === tn || w === tn);
    });
    B("chr", (args) => String.fromCodePoint(numVal(args[0])));
    B("ord", (args) => args[0].codePointAt(0));
    B("hex", (args) => "0x" + (numVal(args[0]) >>> 0).toString(16));
    B("bin", (args) => "0b" + (numVal(args[0]) >>> 0).toString(2));
    B("oct", (args) => "0o" + (numVal(args[0]) >>> 0).toString(8));
    B("pow", (args) => {
      const r = Math.pow(numVal(args[0]), numVal(args[1]));
      return isFloat(args[0]) || isFloat(args[1]) ? mkFloat(r) : r;
    });
    B("divmod", (args) => PyTuple.from([binOp("//", args[0], args[1], self), binOp("%", args[0], args[1], self)]));
    B("any", (args) => Array.from(iterate(self, args[0])).some(truthy));
    B("all", (args) => Array.from(iterate(self, args[0])).every(truthy));
    B("id", (args) => 1);
    B("hash", (args) => { const s = pyRepr(args[0]); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; });

    // minimal modules
    const mathMod = new Map(Object.entries({
      pi: mkFloat(Math.PI), e: mkFloat(Math.E), tau: mkFloat(Math.PI * 2),
      sqrt: new BuiltinFn("sqrt", (a) => mkFloat(Math.sqrt(numVal(a[0])))),
      floor: new BuiltinFn("floor", (a) => Math.floor(numVal(a[0]))),
      ceil: new BuiltinFn("ceil", (a) => Math.ceil(numVal(a[0]))),
      trunc: new BuiltinFn("trunc", (a) => Math.trunc(numVal(a[0]))),
      pow: new BuiltinFn("pow", (a) => mkFloat(Math.pow(numVal(a[0]), numVal(a[1])))),
      sin: new BuiltinFn("sin", (a) => mkFloat(Math.sin(numVal(a[0])))),
      cos: new BuiltinFn("cos", (a) => mkFloat(Math.cos(numVal(a[0])))),
      tan: new BuiltinFn("tan", (a) => mkFloat(Math.tan(numVal(a[0])))),
      log: new BuiltinFn("log", (a) => mkFloat(a.length > 1 ? Math.log(numVal(a[0])) / Math.log(numVal(a[1])) : Math.log(numVal(a[0])))),
      log2: new BuiltinFn("log2", (a) => mkFloat(Math.log2(numVal(a[0])))),
      log10: new BuiltinFn("log10", (a) => mkFloat(Math.log10(numVal(a[0])))),
      exp: new BuiltinFn("exp", (a) => mkFloat(Math.exp(numVal(a[0])))),
      fabs: new BuiltinFn("fabs", (a) => mkFloat(Math.abs(numVal(a[0])))),
      factorial: new BuiltinFn("factorial", (a) => { let n = numVal(a[0]), r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }),
      gcd: new BuiltinFn("gcd", (a) => { let x = Math.abs(numVal(a[0])), y = Math.abs(numVal(a[1])); while (y) { [x, y] = [y, x % y]; } return x; }),
      isnan: new BuiltinFn("isnan", (a) => Number.isNaN(numVal(a[0]))),
      radians: new BuiltinFn("radians", (a) => mkFloat(numVal(a[0]) * Math.PI / 180)),
      degrees: new BuiltinFn("degrees", (a) => mkFloat(numVal(a[0]) * 180 / Math.PI)),
    }));
    const randomMod = new Map(Object.entries({
      random: new BuiltinFn("random", () => mkFloat(Math.random())),
      randint: new BuiltinFn("randint", (a) => { const lo = numVal(a[0]), hi = numVal(a[1]); return lo + Math.floor(Math.random() * (hi - lo + 1)); }),
      randrange: new BuiltinFn("randrange", (a) => { const nums = a.map(numVal); let lo = 0, hi; if (nums.length === 1) hi = nums[0]; else { lo = nums[0]; hi = nums[1]; } return lo + Math.floor(Math.random() * (hi - lo)); }),
      uniform: new BuiltinFn("uniform", (a) => mkFloat(numVal(a[0]) + Math.random() * (numVal(a[1]) - numVal(a[0])))),
      choice: new BuiltinFn("choice", (a) => { const l = Array.from(iterate(self, a[0])); return l[Math.floor(Math.random() * l.length)]; }),
      shuffle: new BuiltinFn("shuffle", (a) => { const l = a[0]; for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; } return NONE; }),
      sample: new BuiltinFn("sample", (a) => { const l = Array.from(iterate(self, a[0])).slice(); const k = numVal(a[1]); const out = []; for (let i = 0; i < k && l.length; i++) out.push(l.splice(Math.floor(Math.random() * l.length), 1)[0]); return out; }),
    }));
    const timeMod = new Map(Object.entries({
      time: new BuiltinFn("time", () => mkFloat(Date.now() / 1000)),
      sleep: new BuiltinFn("sleep", () => NONE),
    }));
    const stringMod = new Map(Object.entries({
      ascii_lowercase: "abcdefghijklmnopqrstuvwxyz",
      ascii_uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      digits: "0123456789",
      punctuation: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
    }));
    this.modules = { math: mathMod, random: randomMod, time: timeMod, string: stringMod };

    g.setLocal("True", true);
    g.setLocal("False", false);
    g.setLocal("None", NONE);
  }

  run(ast) {
    try {
      this.execBlock(ast.body, this.global);
      return { ok: true };
    } catch (e) {
      if (e instanceof PyError) return { ok: false, traceback: this.formatTraceback(e) };
      if (e instanceof ReturnSig || e instanceof BreakSig || e instanceof ContinueSig) return { ok: true };
      // unexpected JS error -> surface as generic error
      return { ok: false, traceback: this.formatTraceback(new PyError("RuntimeError", String(e && e.message || e))) };
    }
  }

  formatTraceback(e) {
    let out = "Traceback (most recent call last):\n";
    out += `  File "main.py", line ${e.line || "?"}, in <module>\n`;
    const srcLine = e.line && this.srcLines[e.line - 1] !== undefined ? this.srcLines[e.line - 1].trim() : "";
    if (srcLine) out += `    ${srcLine}\n`;
    out += `${e.pyName}: ${e.pyMsg}`;
    return out;
  }

  execBlock(stmts, scope) {
    for (const s of stmts) this.execStmt(s, scope);
  }

  execStmt(node, scope) {
    switch (node.type) {
      case "ExprStmt": this.evalExpr(node.value, scope); return;
      case "Assign": {
        const val = this.evalExpr(node.value, scope);
        for (const tgt of node.targets) this.assignTo(tgt, val, scope);
        return;
      }
      case "AugAssign": {
        const cur = this.evalExpr(node.target, scope);
        const rhs = this.evalExpr(node.value, scope);
        const res = binOp(node.op, cur, rhs, this, node.line);
        this.assignTo(node.target, res, scope);
        return;
      }
      case "FunctionDef": {
        const fn = new PyFunction(node.name, node.params, node.vararg, node.kwarg, node.body, scope);
        scope.setLocal(node.name, fn);
        return;
      }
      case "Return": {
        const val = node.value ? this.evalExpr(node.value, scope) : NONE;
        throw new ReturnSig(val);
      }
      case "If": {
        if (truthy(this.evalExpr(node.test, scope))) this.execBlock(node.body, scope);
        else this.execBlock(node.orelse, scope);
        return;
      }
      case "While": {
        let hitBreak = false;
        while (truthy(this.evalExpr(node.test, scope))) {
          try { this.execBlock(node.body, scope); }
          catch (e) { if (e instanceof BreakSig) { hitBreak = true; break; } if (e instanceof ContinueSig) continue; throw e; }
        }
        if (!hitBreak) this.execBlock(node.orelse, scope);
        return;
      }
      case "For": {
        const iterable = this.evalExpr(node.iter, scope);
        let hitBreak = false;
        for (const item of iterate(this, iterable, node.line)) {
          this.assignTo(node.target, item, scope);
          try { this.execBlock(node.body, scope); }
          catch (e) { if (e instanceof BreakSig) { hitBreak = true; break; } if (e instanceof ContinueSig) continue; throw e; }
        }
        if (!hitBreak) this.execBlock(node.orelse, scope);
        return;
      }
      case "Break": throw new BreakSig();
      case "Continue": throw new ContinueSig();
      case "Pass": return;
      case "Import": {
        for (const name of node.names) {
          if (this.modules[name]) scope.setLocal(name, this.modules[name]);
          else this.err("ModuleNotFoundError", `No module named '${name}'`, node.line);
        }
        return;
      }
      case "FromImport": {
        const mod = this.modules[node.mod];
        if (!mod) this.err("ModuleNotFoundError", `No module named '${node.mod}'`, node.line);
        if (node.names[0] === "*") { for (const [k, v] of mod.entries()) scope.setLocal(k, v); return; }
        for (const nm of node.names) {
          if (!mod.has(nm)) this.err("ImportError", `cannot import name '${nm}' from '${node.mod}'`, node.line);
          scope.setLocal(nm, mod.get(nm));
        }
        return;
      }
      case "Global": return; // simplified: no-op (closures already read through to global)
      case "Assert": {
        if (!truthy(this.evalExpr(node.test, scope))) {
          const msg = node.msg ? pyStr(this.evalExpr(node.msg, scope)) : "";
          this.err("AssertionError", msg, node.line);
        }
        return;
      }
      case "Raise": {
        if (!node.exc) this.err("RuntimeError", "No active exception to re-raise", node.line);
        const v = this.evalExpr(node.exc, scope);
        if (typeof v === "string") this.err("Exception", v, node.line);
        if (v && v.__exc__) this.err(v.name, v.msg, node.line);
        this.err("Exception", pyStr(v), node.line);
        return;
      }
      case "Del": {
        if (node.target.type === "Name") {
          if (!scope.vars.delete(node.target.id)) this.err("NameError", `name '${node.target.id}' is not defined`, node.line);
        } else if (node.target.type === "Subscript") {
          const obj = this.evalExpr(node.target.obj, scope);
          const idx = this.evalExpr(node.target.index, scope);
          if (Array.isArray(obj)) obj.splice(normIndex(idx, obj.length), 1);
          else if (obj instanceof Map) obj.delete(canonKey(idx));
        }
        return;
      }
      case "Try": {
        try {
          try { this.execBlock(node.body, scope); }
          catch (e) {
            if (e instanceof PyError) {
              for (const h of node.handlers) {
                if (!h.exType || this.excMatches(h.exType, e, scope)) {
                  if (h.asName) scope.setLocal(h.asName, { __exc__: true, name: e.pyName, msg: e.pyMsg, args: [e.pyMsg] });
                  this.execBlock(h.body, scope);
                  return;
                }
              }
            }
            throw e;
          }
          this.execBlock(node.orelse, scope);
        } finally {
          this.execBlock(node.finalBody, scope);
        }
        return;
      }
      default:
        this.err("SyntaxError", `cannot execute node ${node.type}`, node.line);
    }
  }

  excMatches(exTypeNode, e, scope) {
    try {
      const v = this.evalExpr(exTypeNode, scope);
      const names = Array.isArray(v) || v instanceof PyTuple ? Array.from(v) : [v];
      return names.some((n) => typeof n === "string" && (n === e.pyName || n === "Exception" || n === "BaseException"));
    } catch (_) { return false; }
  }

  assignTo(target, val, scope) {
    if (target.type === "Name") { scope.setLocal(target.id, val); return; }
    if (target.type === "TupleLit" || target.type === "ListLit") {
      const items = Array.from(iterate(this, val));
      const targets = target.items;
      if (items.length !== targets.length) this.err("ValueError", `not enough values to unpack (expected ${targets.length}, got ${items.length})`, target.line);
      for (let i = 0; i < targets.length; i++) this.assignTo(targets[i], items[i], scope);
      return;
    }
    if (target.type === "Subscript") {
      const obj = this.evalExpr(target.obj, scope);
      const idx = this.evalExpr(target.index, scope);
      if (Array.isArray(obj)) {
        const i = normIndex(idx, obj.length);
        obj[i] = val;
      } else if (obj instanceof Map) {
        obj.set(canonKey(idx), val);
      } else this.err("TypeError", `'${typeName(obj)}' object does not support item assignment`, target.line);
      return;
    }
    if (target.type === "Attribute") {
      this.err("AttributeError", "attribute assignment is not supported", target.line);
    }
    this.err("SyntaxError", "cannot assign to this expression", target.line);
  }

  callFunction(fn, args, kwargs, line) {
    if (fn instanceof BuiltinFn) {
      try { return fn.fn(args, kwargs || {}); }
      catch (e) { if (e instanceof PyError) { if (!e.line) e.line = line; throw e; } throw e; }
    }
    if (fn instanceof BoundMethod) return this.callFunction(fn.fn, [fn.self, ...args], kwargs, line);
    if (fn instanceof PyFunction) {
      const local = new Scope(fn.closure);
      const positional = fn.params.filter(() => true);
      let ai = 0;
      for (let i = 0; i < positional.length; i++) {
        const p = positional[i];
        if (kwargs && Object.prototype.hasOwnProperty.call(kwargs, p.name)) {
          local.setLocal(p.name, kwargs[p.name]);
        } else if (ai < args.length) {
          local.setLocal(p.name, args[ai++]);
        } else if (p.def) {
          local.setLocal(p.name, this.evalExpr(p.def, fn.closure));
        } else {
          this.err("TypeError", `${fn.name}() missing required argument: '${p.name}'`, line);
        }
      }
      if (fn.vararg) local.setLocal(fn.vararg, PyTuple.from(args.slice(ai)));
      if (fn.kwarg) {
        const m = new Map();
        if (kwargs) for (const k in kwargs) if (!positional.some((p) => p.name === k)) m.set(k, kwargs[k]);
        local.setLocal(fn.kwarg, m);
      }
      try {
        this.execBlock(fn.body, local);
      } catch (e) {
        if (e instanceof ReturnSig) return e.value;
        throw e;
      }
      return NONE;
    }
    this.err("TypeError", `'${typeName(fn)}' object is not callable`, line);
  }

  evalExpr(node, scope) {
    switch (node.type) {
      case "Num": return node.value;
      case "Str": return node.value;
      case "Bool": return node.value;
      case "NoneLit": return NONE;
      case "FString": return this.evalFString(node.raw, scope, node.line);
      case "Name": {
        if (this.modules[node.id] && !scope.has(node.id)) return this.modules[node.id];
        if (!scope.has(node.id)) {
          if (node.id === "True") return true;
          if (node.id === "False") return false;
          if (node.id === "None") return NONE;
          this.err("NameError", `name '${node.id}' is not defined`, node.line);
        }
        return scope.get(node.id);
      }
      case "TupleLit": return PyTuple.from(node.items.map((it) => this.evalExpr(it, scope)));
      case "ListLit": return node.items.map((it) => this.evalExpr(it, scope));
      case "SetLit": return new Set(node.items.map((it) => canonKey(this.evalExpr(it, scope))));
      case "DictLit": {
        const m = new Map();
        for (const it of node.items) m.set(canonKey(this.evalExpr(it.key, scope)), this.evalExpr(it.value, scope));
        return m;
      }
      case "ListComp": {
        const out = [];
        this.runComp(node, scope, (s) => out.push(this.evalExpr(node.elt, s)));
        return out;
      }
      case "SetComp": {
        const out = new Set();
        this.runComp(node, scope, (s) => out.add(canonKey(this.evalExpr(node.elt, s))));
        return out;
      }
      case "GenExp": {
        const out = [];
        this.runComp(node, scope, (s) => out.push(this.evalExpr(node.elt, s)));
        return out;
      }
      case "DictComp": {
        const out = new Map();
        this.runComp(node, scope, (s) => out.set(canonKey(this.evalExpr(node.key, s)), this.evalExpr(node.val, s)));
        return out;
      }
      case "BoolOp": {
        const l = this.evalExpr(node.left, scope);
        if (node.op === "and") return truthy(l) ? this.evalExpr(node.right, scope) : l;
        return truthy(l) ? l : this.evalExpr(node.right, scope);
      }
      case "UnaryOp": {
        const v = this.evalExpr(node.operand, scope);
        if (node.op === "not") return !truthy(v);
        if (node.op === "-") return isFloat(v) ? mkFloat(-v.v) : -v;
        if (node.op === "+") return v;
        if (node.op === "~") return ~numVal(v);
        break;
      }
      case "BinOp": {
        const l = this.evalExpr(node.left, scope);
        const r = this.evalExpr(node.right, scope);
        return binOp(node.op, l, r, this, node.line);
      }
      case "Compare": {
        let left = this.evalExpr(node.left, scope);
        for (const { op, right } of node.ops) {
          const rv = this.evalExpr(right, scope);
          if (!compareOp(op, left, rv, this)) return false;
          left = rv;
        }
        return true;
      }
      case "IfExp": return truthy(this.evalExpr(node.test, scope)) ? this.evalExpr(node.body, scope) : this.evalExpr(node.orelse, scope);
      case "Lambda": {
        return new PyFunction("<lambda>", node.params, null, null, [{ type: "Return", value: node.body, line: node.line }], scope);
      }
      case "Call": {
        const fn = this.evalExpr(node.func, scope);
        const args = [];
        for (const a of node.args) {
          if (a.star) { for (const it of iterate(this, this.evalExpr(a.value, scope))) args.push(it); }
          else args.push(this.evalExpr(a.value, scope));
        }
        const kwargs = {};
        for (const k of node.kwargs) kwargs[k.name] = this.evalExpr(k.value, scope);
        return this.callFunction(fn, args, kwargs, node.line);
      }
      case "Subscript": {
        const obj = this.evalExpr(node.obj, scope);
        const idx = this.evalExpr(node.index, scope);
        return getItem(this, obj, idx, node.line);
      }
      case "Slice": {
        const obj = this.evalExpr(node.obj, scope);
        const lower = node.lower ? numVal(this.evalExpr(node.lower, scope)) : undefined;
        const upper = node.upper ? numVal(this.evalExpr(node.upper, scope)) : undefined;
        const step = node.step ? numVal(this.evalExpr(node.step, scope)) : undefined;
        return doSlice(obj, lower, upper, step);
      }
      case "Attribute": {
        const obj = this.evalExpr(node.obj, scope);
        return getAttribute(this, obj, node.attr, node.line);
      }
      default:
        this.err("SyntaxError", `cannot evaluate node ${node.type}`, node.line);
    }
  }

  runComp(node, scope, emit) {
    const self = this;
    function loop(s) {
      for (const item of iterate(self, self.evalExpr(node.iter, s))) {
        const inner = new Scope(s);
        self.assignTo(node.target, item, inner);
        if (node.ifs.every((c) => truthy(self.evalExpr(c, inner)))) emit(inner);
      }
    }
    loop(scope);
  }

  evalFString(raw, scope, line) {
    const parts = parseFStringParts(raw);
    let out = "";
    for (const p of parts) {
      if (p.lit !== undefined) { out += p.lit; continue; }
      const toks = tokenize(p.expr + "\n");
      const parser = new Parser(toks);
      let exprAst;
      try { exprAst = parser.parseExprList(); } catch (e) { this.err("SyntaxError", `invalid f-string expression: ${p.expr}`, line); }
      let val = this.evalExpr(exprAst, scope);
      if (p.fmt) val = applyFormatSpec(val, p.fmt);
      else val = pyStr(val);
      out += val;
    }
    return out;
  }
}

function applyFormatSpec(val, spec) {
  let m = /^(?:(.)?([<>^]))?([+\- ])?(#)?(0)?(\d+)?(,)?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
  if (!m) return pyStr(val);
  let [, fillCh, align, sign, alt, zero, width, comma, prec, type] = m;
  width = width ? parseInt(width, 10) : 0;
  let s;
  const num = isNum(val) ? numVal(val) : null;
  if (type === "f" || type === "F") s = num.toFixed(prec !== undefined ? parseInt(prec, 10) : 6);
  else if (type === "%") s = (num * 100).toFixed(prec !== undefined ? parseInt(prec, 10) : 6) + "%";
  else if (type === "d") s = String(Math.trunc(num));
  else if (type === "x") s = Math.trunc(num).toString(16);
  else if (type === "X") s = Math.trunc(num).toString(16).toUpperCase();
  else if (type === "o") s = Math.trunc(num).toString(8);
  else if (type === "b") s = Math.trunc(num).toString(2);
  else if (type === "e" || type === "E") s = num.toExponential(prec !== undefined ? parseInt(prec, 10) : 6);
  else if (prec !== undefined && typeof val === "string") s = val.slice(0, parseInt(prec, 10));
  else if (prec !== undefined && num !== null) s = num.toFixed(parseInt(prec, 10));
  else s = pyStr(val);
  if (comma && num !== null) {
    const neg = s.startsWith("-");
    let [ip, fp] = (neg ? s.slice(1) : s).split(".");
    ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    s = (neg ? "-" : "") + ip + (fp ? "." + fp : "");
  }
  if (sign === "+" && num !== null && num >= 0) s = "+" + s;
  const fc = fillCh || (zero ? "0" : " ");
  if (width && s.length < width) {
    const pad = fc.repeat(width - s.length);
    if (align === "<") s = s + pad;
    else if (align === "^") { const l = Math.floor((width - s.length) / 2); s = fc.repeat(l) + s + fc.repeat(width - s.length - l); }
    else s = pad + s; // default right-align for numbers
  }
  return s;
}

/* ---- comparisons / operators ---- */
function canonKey(v) {
  // dict/set keys: normalize numbers so 1 == 1.0 behaves, keep strings/bools/tuples as-is
  if (isFloat(v)) return v.v;
  return v;
}
function compareVals(a, b) {
  const an = isNum(a) ? numVal(a) : null, bn = isNum(b) ? numVal(b) : null;
  if (an !== null && bn !== null) return an - bn;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}
function valsEqual(a, b) {
  if (isNum(a) && isNum(b)) return numVal(a) === numVal(b);
  if (a === NONE || b === NONE) return a === b;
  if (typeof a === "string" || typeof b === "string" || typeof a === "boolean" || typeof b === "boolean") return a === b;
  if ((Array.isArray(a) && Array.isArray(b))) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valsEqual(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a.entries()) { if (!b.has(k) || !valsEqual(b.get(k), v)) return false; }
    return true;
  }
  return a === b;
}
function compareOp(op, a, b, interp) {
  switch (op) {
    case "==": return valsEqual(a, b);
    case "!=": return !valsEqual(a, b);
    case "<": return compareVals(a, b) < 0;
    case ">": return compareVals(a, b) > 0;
    case "<=": return compareVals(a, b) <= 0;
    case ">=": return compareVals(a, b) >= 0;
    case "is": return a === b || (a === NONE && b === NONE);
    case "is not": return !(a === b || (a === NONE && b === NONE));
    case "in": return containsCheck(a, b);
    case "not in": return !containsCheck(a, b);
  }
  return false;
}
function containsCheck(item, container) {
  if (typeof container === "string") return container.indexOf(pyStr(item)) !== -1;
  if (Array.isArray(container)) return container.some((x) => valsEqual(x, item));
  if (container instanceof Map) return container.has(canonKey(item));
  if (container instanceof Set) return container.has(canonKey(item));
  return false;
}

function reduceMinMax(self, args, dir) {
  let items, keyFn = null;
  if (args.length === 1 && (Array.isArray(args[0]) || args[0] instanceof Map || args[0] instanceof Set || typeof args[0] === "string")) {
    items = Array.from(iterate(self, args[0]));
  } else {
    items = args.filter((a) => !(a && a.__kw));
  }
  if (!items.length) self.err("ValueError", dir < 0 ? "min() arg is an empty sequence" : "max() arg is an empty sequence");
  let best = items[0];
  for (const it of items.slice(1)) { if (compareVals(it, best) * dir > 0) best = it; }
  return best;
}

/* ---- arithmetic ---- */
function binOp(op, a, b, interp, line) {
  if (op === "+") {
    if (typeof a === "string" || typeof b === "string") {
      if (typeof a === "string" && typeof b === "string") return a + b;
      interp.err("TypeError", `can only concatenate str (not "${typeName(typeof a === "string" ? b : a)}") to str`, line);
    }
    if (Array.isArray(a) && Array.isArray(b)) return a instanceof PyTuple ? PyTuple.from([...a, ...b]) : [...a, ...b];
    if (isNum(a) && isNum(b)) return numArith(a, b, (x, y) => x + y);
    interp.err("TypeError", `unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`, line);
  }
  if (op === "-") {
    if (isNum(a) && isNum(b)) return numArith(a, b, (x, y) => x - y);
    interp.err("TypeError", `unsupported operand type(s) for -: '${typeName(a)}' and '${typeName(b)}'`, line);
  }
  if (op === "*") {
    if (typeof a === "string" && isInt(b)) return a.repeat(Math.max(0, b));
    if (typeof b === "string" && isInt(a)) return b.repeat(Math.max(0, a));
    if (Array.isArray(a) && isInt(b)) { const out = []; for (let i = 0; i < b; i++) out.push(...a); return a instanceof PyTuple ? PyTuple.from(out) : out; }
    if (Array.isArray(b) && isInt(a)) { const out = []; for (let i = 0; i < a; i++) out.push(...b); return b instanceof PyTuple ? PyTuple.from(out) : out; }
    if (isNum(a) && isNum(b)) return numArith(a, b, (x, y) => x * y);
    interp.err("TypeError", `can't multiply sequence by non-int of type '${typeName(isNum(a) ? b : a)}'`, line);
  }
  if (op === "/") {
    if (isNum(a) && isNum(b)) {
      if (numVal(b) === 0) interp.err("ZeroDivisionError", "division by zero", line);
      return mkFloat(numVal(a) / numVal(b));
    }
    interp.err("TypeError", `unsupported operand type(s) for /: '${typeName(a)}' and '${typeName(b)}'`, line);
  }
  if (op === "//") {
    if (isNum(a) && isNum(b)) {
      if (numVal(b) === 0) interp.err("ZeroDivisionError", "integer division or modulo by zero", line);
      const r = Math.floor(numVal(a) / numVal(b));
      return isFloat(a) || isFloat(b) ? mkFloat(r) : r;
    }
    interp.err("TypeError", `unsupported operand type(s) for //: '${typeName(a)}' and '${typeName(b)}'`, line);
  }
  if (op === "%") {
    if (typeof a === "string") return pyFormatPercent(a, b);
    if (isNum(a) && isNum(b)) {
      if (numVal(b) === 0) interp.err("ZeroDivisionError", "modulo by zero", line);
      const x = numVal(a), y = numVal(b);
      const r = ((x % y) + y) % y;
      return isFloat(a) || isFloat(b) ? mkFloat(r) : r;
    }
    interp.err("TypeError", `unsupported operand type(s) for %: '${typeName(a)}' and '${typeName(b)}'`, line);
  }
  if (op === "**") {
    if (isNum(a) && isNum(b)) {
      const r = Math.pow(numVal(a), numVal(b));
      return isFloat(a) || isFloat(b) || numVal(b) < 0 ? mkFloat(r) : r;
    }
    interp.err("TypeError", `unsupported operand type(s) for ** or pow(): '${typeName(a)}' and '${typeName(b)}'`, line);
  }
  if (op === "|") {
    if (a instanceof Set && b instanceof Set) return new Set([...a, ...b]);
    return numVal(a) | numVal(b);
  }
  if (op === "&") {
    if (a instanceof Set && b instanceof Set) return new Set([...a].filter((x) => b.has(x)));
    return numVal(a) & numVal(b);
  }
  interp.err("TypeError", `unsupported operand: ${op}`, line);
}
function numArith(a, b, fn) {
  const r = fn(numVal(a), numVal(b));
  return isFloat(a) || isFloat(b) ? mkFloat(r) : r;
}
function pyFormatPercent(fmt, arg) {
  const args = Array.isArray(arg) ? arg.slice() : [arg];
  let i = 0;
  return fmt.replace(/%[sdif%]/g, (m) => {
    if (m === "%%") return "%";
    const v = args[i++];
    if (m === "%d" || m === "%i") return String(Math.trunc(numVal(v)));
    if (m === "%f") return numVal(v).toFixed(6);
    return pyStr(v);
  });
}

/* ---- indexing / slicing / iteration ---- */
function normIndex(idx, len) {
  let i = numVal(idx);
  if (i < 0) i += len;
  return i;
}
function getItem(interp, obj, idx, line) {
  if (typeof obj === "string" || Array.isArray(obj)) {
    const i = normIndex(idx, obj.length);
    if (i < 0 || i >= obj.length) interp.err(typeof obj === "string" ? "IndexError" : "IndexError", typeof obj === "string" ? "string index out of range" : "list index out of range", line);
    return obj[i];
  }
  if (obj instanceof Map) {
    const k = canonKey(idx);
    if (!obj.has(k)) interp.err("KeyError", pyRepr(idx), line);
    return obj.get(k);
  }
  interp.err("TypeError", `'${typeName(obj)}' object is not subscriptable`, line);
}
function doSlice(obj, lower, upper, step) {
  const isStr = typeof obj === "string";
  const arr = isStr ? Array.from(obj) : obj;
  const len = arr.length;
  step = step === undefined ? 1 : step;
  if (step === 0) step = 1;
  let start, stop;
  if (step > 0) {
    start = lower === undefined ? 0 : (lower < 0 ? Math.max(len + lower, 0) : Math.min(lower, len));
    stop = upper === undefined ? len : (upper < 0 ? Math.max(len + upper, 0) : Math.min(upper, len));
  } else {
    start = lower === undefined ? len - 1 : (lower < 0 ? Math.max(len + lower, -1) : Math.min(lower, len - 1));
    stop = upper === undefined ? -1 : (upper < 0 ? Math.max(len + upper, -1) : Math.min(upper, len - 1));
  }
  const out = [];
  if (step > 0) for (let i = start; i < stop; i += step) out.push(arr[i]);
  else for (let i = start; i > stop; i += step) out.push(arr[i]);
  if (isStr) return out.join("");
  return obj instanceof PyTuple ? PyTuple.from(out) : out;
}
function* iterate(interp, obj, line) {
  if (typeof obj === "string") { for (const ch of obj) yield ch; return; }
  if (Array.isArray(obj)) { for (const it of obj) yield it; return; }
  if (obj instanceof Map) { for (const k of obj.keys()) yield k; return; }
  if (obj instanceof Set) { for (const v of obj) yield v; return; }
  interp.err("TypeError", `'${typeName(obj)}' object is not iterable`, line);
}

/* ---- attribute / method access (strings, lists, dicts, sets, modules) ---- */
function getAttribute(interp, obj, attr, line) {
  if (obj instanceof Map && !(attr in {}) && MODULE_LIKE(obj)) {
    // module (Map of exported names)
  }
  if (obj && obj.__module__) { /* unused */ }
  // module access: our modules are plain Map instances too, so disambiguate via a marker
  if (obj instanceof Map && obj.__isModule) {
    if (!obj.has(attr)) interp.err("AttributeError", `module has no attribute '${attr}'`, line);
    return obj.get(attr);
  }
  if (typeof obj === "string") return strMethod(interp, obj, attr, line);
  if (Array.isArray(obj)) return listMethod(interp, obj, attr, line);
  if (obj instanceof Map) return dictOrModuleMethod(interp, obj, attr, line);
  if (obj instanceof Set) return setMethod(interp, obj, attr, line);
  interp.err("AttributeError", `'${typeName(obj)}' object has no attribute '${attr}'`, line);
}
function MODULE_LIKE() { return false; }

function wrapBI(name, fn) { return new BuiltinFn(name, fn); }

function strMethod(interp, s, attr, line) {
  const M = {
    upper: () => s.toUpperCase(),
    lower: () => s.toLowerCase(),
    strip: (a) => a.length ? stripChars(s, a[0], true, true) : s.trim(),
    lstrip: (a) => a.length ? stripChars(s, a[0], true, false) : s.replace(/^\s+/, ""),
    rstrip: (a) => a.length ? stripChars(s, a[0], false, true) : s.replace(/\s+$/, ""),
    split: (a) => {
      if (!a.length || a[0] === NONE) return s.trim().split(/\s+/).filter((x) => x.length);
      const sep = a[0];
      const limit = a.length > 1 ? numVal(a[1]) : -1;
      if (limit < 0) return s.split(sep);
      const parts = s.split(sep);
      if (parts.length <= limit + 1) return parts;
      return parts.slice(0, limit).concat(parts.slice(limit).join(sep));
    },
    rsplit: (a) => s.split(a.length ? a[0] : /\s+/),
    splitlines: () => s.split(/\r\n|\r|\n/).filter((x, i, arr) => !(i === arr.length - 1 && x === "")),
    join: (a) => Array.from(iterate(interp, a[0])).map(pyStr).join(s),
    replace: (a) => s.split(a[0]).join(a[1]),
    find: (a) => s.indexOf(a[0]),
    rfind: (a) => s.lastIndexOf(a[0]),
    index: (a) => { const i = s.indexOf(a[0]); if (i === -1) interp.err("ValueError", "substring not found", line); return i; },
    count: (a) => a[0] === "" ? s.length + 1 : s.split(a[0]).length - 1,
    startswith: (a) => s.startsWith(a[0]),
    endswith: (a) => s.endsWith(a[0]),
    capitalize: () => s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s,
    title: () => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
    swapcase: () => s.split("").map((c) => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(""),
    isdigit: () => /^\d+$/.test(s),
    isalpha: () => /^[A-Za-z]+$/.test(s),
    isalnum: () => /^[A-Za-z0-9]+$/.test(s),
    isspace: () => /^\s+$/.test(s),
    isupper: () => s !== s.toLowerCase() && s === s.toUpperCase(),
    islower: () => s !== s.toUpperCase() && s === s.toLowerCase(),
    format: (a, kw) => formatStrMethod(s, a, kw),
    zfill: (a) => { const w = numVal(a[0]); const neg = s.startsWith("-"); const body = neg ? s.slice(1) : s; const pad = Math.max(0, w - s.length); return (neg ? "-" : "") + "0".repeat(pad) + body; },
    center: (a) => { const w = numVal(a[0]); const fill = a.length > 1 ? a[1] : " "; const total = Math.max(0, w - s.length); const l = Math.floor(total / 2); return fill.repeat(l) + s + fill.repeat(total - l); },
    ljust: (a) => { const w = numVal(a[0]); const fill = a.length > 1 ? a[1] : " "; return s.length >= w ? s : s + fill.repeat(w - s.length); },
    rjust: (a) => { const w = numVal(a[0]); const fill = a.length > 1 ? a[1] : " "; return s.length >= w ? s : fill.repeat(w - s.length) + s; },
    encode: () => s,
  };
  if (!(attr in M)) interp.err("AttributeError", `'str' object has no attribute '${attr}'`, line);
  return wrapBI(attr, (a, kw) => M[attr](a, kw));
}
function stripChars(s, chars, left, right) {
  let start = 0, end = s.length;
  if (left) while (start < end && chars.indexOf(s[start]) !== -1) start++;
  if (right) while (end > start && chars.indexOf(s[end - 1]) !== -1) end--;
  return s.slice(start, end);
}
function formatStrMethod(s, args, kwargs) {
  let auto = 0;
  return s.replace(/\{(\d*|[A-Za-z_]\w*)(:[^}]*)?\}/g, (m, key, fmt) => {
    let val;
    if (key === "") val = args[auto++];
    else if (/^\d+$/.test(key)) val = args[parseInt(key, 10)];
    else val = kwargs[key];
    if (fmt) return applyFormatSpec(val, fmt.slice(1));
    return pyStr(val);
  });
}

function listMethod(interp, l, attr, line) {
  const M = {
    append: (a) => { l.push(a[0]); return NONE; },
    extend: (a) => { for (const it of iterate(interp, a[0])) l.push(it); return NONE; },
    insert: (a) => { l.splice(numVal(a[0]), 0, a[1]); return NONE; },
    pop: (a) => { if (!l.length) interp.err("IndexError", "pop from empty list", line); const i = a.length ? normIndex(a[0], l.length) : l.length - 1; if (i < 0 || i >= l.length) interp.err("IndexError", "pop index out of range", line); return l.splice(i, 1)[0]; },
    remove: (a) => { const i = l.findIndex((x) => valsEqual(x, a[0])); if (i === -1) interp.err("ValueError", "list.remove(x): x not in list", line); l.splice(i, 1); return NONE; },
    clear: () => { l.length = 0; return NONE; },
    index: (a) => { const i = l.findIndex((x) => valsEqual(x, a[0])); if (i === -1) interp.err("ValueError", `${pyRepr(a[0])} is not in list`, line); return i; },
    count: (a) => l.filter((x) => valsEqual(x, a[0])).length,
    sort: (a, kw) => { const rev = kw && truthy(kw.reverse); const keyFn = kw && kw.key; l.sort((x, y) => compareVals(keyFn ? interp.callFunction(keyFn, [x], {}) : x, keyFn ? interp.callFunction(keyFn, [y], {}) : y)); if (rev) l.reverse(); return NONE; },
    reverse: () => { l.reverse(); return NONE; },
    copy: () => l.slice(),
  };
  if (!(attr in M)) interp.err("AttributeError", `'list' object has no attribute '${attr}'`, line);
  return wrapBI(attr, (a, kw) => M[attr](a, kw));
}

function dictOrModuleMethod(interp, m, attr, line) {
  const M = {
    get: (a) => m.has(canonKey(a[0])) ? m.get(canonKey(a[0])) : (a.length > 1 ? a[1] : NONE),
    keys: () => Array.from(m.keys()),
    values: () => Array.from(m.values()),
    items: () => Array.from(m.entries()).map(([k, v]) => PyTuple.from([k, v])),
    pop: (a) => { const k = canonKey(a[0]); if (!m.has(k)) { if (a.length > 1) return a[1]; interp.err("KeyError", pyRepr(a[0]), line); } const v = m.get(k); m.delete(k); return v; },
    update: (a) => { const other = a[0]; if (other instanceof Map) for (const [k, v] of other.entries()) m.set(k, v); return NONE; },
    setdefault: (a) => { const k = canonKey(a[0]); if (!m.has(k)) m.set(k, a.length > 1 ? a[1] : NONE); return m.get(k); },
    clear: () => { m.clear(); return NONE; },
    copy: () => new Map(m),
  };
  if (!(attr in M)) interp.err("AttributeError", `'dict' object has no attribute '${attr}'`, line);
  return wrapBI(attr, (a) => M[attr](a));
}
function setMethod(interp, s, attr, line) {
  const M = {
    add: (a) => { s.add(canonKey(a[0])); return NONE; },
    remove: (a) => { const k = canonKey(a[0]); if (!s.has(k)) interp.err("KeyError", pyRepr(a[0]), line); s.delete(k); return NONE; },
    discard: (a) => { s.delete(canonKey(a[0])); return NONE; },
    pop: () => { const it = s.values().next(); if (it.done) interp.err("KeyError", "'pop from an empty set'", line); s.delete(it.value); return it.value; },
    clear: () => { s.clear(); return NONE; },
    union: (a) => new Set([...s, ...Array.from(iterate(interp, a[0]))]),
    intersection: (a) => { const o = new Set(Array.from(iterate(interp, a[0]))); return new Set([...s].filter((x) => o.has(x))); },
    difference: (a) => { const o = new Set(Array.from(iterate(interp, a[0]))); return new Set([...s].filter((x) => !o.has(x))); },
  };
  if (!(attr in M)) interp.err("AttributeError", `'set' object has no attribute '${attr}'`, line);
  return wrapBI(attr, (a) => M[attr](a));
}

/* mark module maps */
function markModule(m) { m.__isModule = true; return m; }

/* ========================= PUBLIC API ========================= */
function runPython(src, opts) {
  const interp = new Interpreter({ print: opts.print, input: opts.input, srcLines: src.split("\n") });
  for (const k in interp.modules) markModule(interp.modules[k]);
  let ast;
  try {
    const toks = tokenize(src);
    const parser = new Parser(toks);
    ast = parser.parseModule();
  } catch (e) {
    if (e instanceof PyError) return { ok: false, traceback: interp.formatTraceback(e) };
    return { ok: false, traceback: `Traceback (most recent call last):\nSyntaxError: ${e.message}` };
  }
  return interp.run(ast);
}

const MogiPy = { run: runPython, tokenize, Parser };
if (typeof module !== "undefined" && module.exports) module.exports = MogiPy;
else global.MogiPy = MogiPy;

})(typeof window !== "undefined" ? window : globalThis);
