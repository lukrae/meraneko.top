/* 共享词法层：C++ / Python 词法分析 + 语义等价性比对
 *
 * token 形状：{ k, t, ln }
 *   k = nl | ws | lc（行注释）| bc（块注释）| pp（预处理指令）| str | num | id | op | cont（Python 反斜杠续行）
 * 空白（ws/nl）保留在流里，格式化器自行折叠；sig() 过滤出「有意义的 token」并附带换行/空格元数据。
 */
(function (root) {
  'use strict';

  function mk(k, t, ln) { return { k: k, t: t, ln: ln }; }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isAlpha(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c.charCodeAt(0) > 127;
  }
  function isAlnum(c) { return isAlpha(c) || isDigit(c); }
  // 关键字/运算符表一律用无原型对象：否则 LABEL['constructor'] 会取到 Object.prototype.constructor
  function set(list) {
    var m = Object.create(null);
    for (var i = 0; i < list.length; i++) m[list[i]] = 1;
    return m;
  }
  function setOf(o) {
    var m = Object.create(null);
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) m[k] = o[k];
    return m;
  }
  function eqFold(list) { return set(list); }

  var CPP_KW = eqFold(('alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t ' +
    'class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default ' +
    'delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable ' +
    'namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires ' +
    'return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try ' +
    'typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq ' +
    'override final int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t ssize_t ptrdiff_t ' +
    'string wstring vector map set unordered_map unordered_set pair tuple shared_ptr unique_ptr weak_ptr optional variant ' +
    'function array deque list queue stack bitset istream ostream istringstream ostringstream string_view span').split(' '));

  var PY_KW = eqFold(('False None True and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '));

  // 调用时 `(` 前不加空格的 C++ 关键字族（其余控制关键字加空格）
  var CPP_TIGHT_CALL = eqFold(('sizeof alignof decltype noexcept typeid static_assert alignas __typeof__ __attribute__ ' +
    'requires').split(' '));

  var CPP_OPS = ['<<=', '>>=', '<=>', '->*', '...', '::', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##', '.*'];
  var PY_OPS = ['**=', '//=', '>>=', '<<=', ':=', '->', '**', '//', '<<', '>>', '<=', '>=', '==', '!=', '+=', '-=', '*=',
    '/=', '%=', '&=', '|=', '^=', '@=', '<>'];

  /* ---------------- C++ ---------------- */
  function lexCpp(src) {
    var toks = [], errs = [], i = 0, n = src.length, ln = 1, lineStart = true;

    function err(msg) { errs.push({ msg: msg, ln: ln }); }
    function push(k, t) { toks.push(mk(k, t, ln)); lineStart = false; }

    function readLineComment(start) {
      var j = start;
      while (j < n && src[j] !== '\n') j++;
      return j;
    }
    function readBlock(start) {
      var j = start + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      if (j >= n) { err('未闭合的块注释 /*'); return n; }
      return j + 2;
    }
    function readQuoted(start, q) {
      var j = start + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) return j + 1;
        if (src[j] === '\n') { err('字符串/字符字面量内出现未转义换行'); return j; }
        j++;
      }
      err('未闭合的字面量');
      return n;
    }
    function readRaw(start) {
      // R"delim( ... )delim"
      var j = start + 1; // 指向 "
      var open = src.indexOf('(', j + 1);
      if (src[j] !== '"' || open < 0) { err('原始字符串写法异常'); return readQuoted(j, '"'); }
      var delim = src.slice(j + 1, open);
      var close = src.indexOf(')' + delim + '"', open + 1);
      if (close < 0) { err('未闭合的原始字符串 R"'); return n; }
      return close + delim.length + 2;
    }
    function readNumber(j) {
      if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
        j += 2; while (j < n && (/[0-9a-fA-F]/.test(src[j]) || (src[j] === "'" && isAlnum(src[j + 1])))) j++;
      } else if (src[j] === '0' && (src[j + 1] === 'b' || src[j + 1] === 'B')) {
        j += 2; while (j < n && (/[01]/.test(src[j]) || (src[j] === "'" && isAlnum(src[j + 1])))) j++;
      } else {
        while (j < n && (isDigit(src[j]) || (src[j] === "'" && isDigit(src[j + 1])))) j++;
        if (src[j] === '.' && isDigit(src[j + 1])) { j++; while (j < n && (isDigit(src[j]) || (src[j] === "'" && isDigit(src[j + 1])))) j++; }
        else if (src[j] === '.' && !isAlpha(src[j + 1]) && src[j + 1] !== '.') { j++; }
        if (src[j] === 'e' || src[j] === 'E' || src[j] === 'p' || src[j] === 'P') {
          var save = j; j++;
          if (src[j] === '+' || src[j] === '-') j++;
          if (isDigit(src[j])) { while (j < n && isDigit(src[j])) j++; } else j = save;
        }
      }
      while (j < n && /[uUlLfFzZ]/.test(src[j])) j++;
      while (j < n && isAlnum(src[j])) j++;
      return j;
    }

    while (i < n) {
      var c = src[i];
      if (c === '\n') { var j = i; while (j < n && src[j] === '\n') j++; toks.push(mk('nl', src.slice(i, j), ln)); ln += j - i; i = j; lineStart = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
        var j2 = i; while (j2 < n && (src[j2] === ' ' || src[j2] === '\t' || src[j2] === '\r' || src[j2] === '\f' || src[j2] === '\v')) j2++;
        toks.push(mk('ws', src.slice(i, j2), ln)); i = j2; continue;
      }
      if (c === '#' && lineStart) {
        var k = i;
        while (k < n) {
          if (src[k] === '\n') { if (src[k - 1] === '\\') { k++; ln++; continue; } break; }
          k++;
        }
        toks.push(mk('pp', src.slice(i, k), ln)); lineStart = false; i = k; continue;
      }
      if (c === '/' && src[i + 1] === '/') { var e1 = readLineComment(i); toks.push(mk('lc', src.slice(i, e1), ln)); i = e1; lineStart = false; continue; }
      if (c === '/' && src[i + 1] === '*') {
        var e2 = readBlock(i), txt = src.slice(i, e2);
        toks.push(mk('bc', txt, ln)); ln += (txt.match(/\n/g) || []).length; i = e2; lineStart = false; continue;
      }
      if (isAlpha(c)) {
        var j3 = i; while (j3 < n && isAlnum(src[j3])) j3++;
        var word = src.slice(i, j3);
        var isRaw = /^(u8|u|U|L)?R$/.test(word);
        var isPref = /^(u8|u|U|L)$/.test(word) || isRaw;
        if (isPref && (src[j3] === '"' || src[j3] === "'")) {
          var e3 = isRaw && src[j3] === '"' ? readRaw(j3) : readQuoted(j3, src[j3]);
          toks.push(mk(src[j3] === '"' ? 'str' : 'chr', src.slice(i, e3), ln));
          ln += (src.slice(i, e3).match(/\n/g) || []).length; i = e3; lineStart = false; continue;
        }
        toks.push(mk('id', word, ln)); i = j3; lineStart = false; continue;
      }
      if (c === '"' || c === "'") {
        var e4 = readQuoted(i, c);
        var lit = src.slice(i, e4);
        toks.push(mk(c === '"' ? 'str' : 'chr', lit, ln));
        ln += (lit.match(/\n/g) || []).length; i = e4; lineStart = false; continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) { var e5 = readNumber(i); toks.push(mk('num', src.slice(i, e5), ln)); i = e5; lineStart = false; continue; }
      var op = null;
      for (var oi = 0; oi < CPP_OPS.length; oi++) { if (src.startsWith(CPP_OPS[oi], i)) { op = CPP_OPS[oi]; break; } }
      if (!op) op = c;
      toks.push(mk('op', op, ln)); i += op.length; lineStart = false;
    }
    return { tokens: toks, errors: errs };
  }

  /* ---------------- Python ---------------- */
  function lexPy(src) {
    var toks = [], errs = [], i = 0, n = src.length, ln = 1;

    function err(msg) { errs.push({ msg: msg, ln: ln }); }
    function readString(j, q, triple) {
      var k = j + q.length;
      while (k < n) {
        if (src[k] === '\\') { k += 2; continue; }
        if (!triple && src[k] === '\n') { err('字符串内出现未转义换行'); return k; }
        if (triple) { if (src.startsWith(q + q + q, k)) return k + 3; }
        else if (src[k] === q) return k + 1;
        k++;
      }
      err('未闭合的字符串字面量');
      return n;
    }
    function readNumber(j) {
      if (src[j] === '0' && /[xXoObB]/.test(src[j + 1])) {
        j += 2; while (j < n && (/[0-9a-fA-F_]/.test(src[j]))) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === '.' && /[0-9_]/.test(src[j + 1])) { j++; while (j < n && /[0-9_]/.test(src[j])) j++; }
        else if (src[j] === '.' && !isAlpha(src[j + 1])) j++;
        if (src[j] === 'e' || src[j] === 'E') {
          var save = j; j++;
          if (src[j] === '+' || src[j] === '-') j++;
          if (/[0-9]/.test(src[j] || '')) { while (j < n && /[0-9_]/.test(src[j])) j++; } else j = save;
        }
      }
      if (src[j] === 'j' || src[j] === 'J') j++;
      return j;
    }

    while (i < n) {
      var c = src[i];
      if (c === '\n') { var j = i; while (j < n && src[j] === '\n') j++; toks.push(mk('nl', src.slice(i, j), ln)); ln += j - i; i = j; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
        var j2 = i; while (j2 < n && (src[j2] === ' ' || src[j2] === '\t' || src[j2] === '\r' || src[j2] === '\f')) j2++;
        toks.push(mk('ws', src.slice(i, j2), ln)); i = j2; continue;
      }
      if (c === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
        var jc = i + 1; if (src[jc] === '\r') jc++;
        if (src[jc] === '\n') jc++;
        toks.push(mk('cont', src.slice(i, jc), ln)); ln++; i = jc; continue;
      }
      if (c === '#') {
        var e1 = i; while (e1 < n && src[e1] !== '\n') e1++;
        toks.push(mk('lc', src.slice(i, e1), ln)); i = e1; continue;
      }
      if (isAlpha(c)) {
        var j3 = i; while (j3 < n && isAlnum(src[j3])) j3++;
        var word = src.slice(i, j3);
        var q = null;
        if (/^(r|b|f|u|rb|br|rf|fr)$/i.test(word) && (src[j3] === '"' || src[j3] === "'")) q = src[j3];
        if (q) {
          var triple = src.startsWith(q + q + q, j3);
          var e3 = readString(j3, q, triple);
          var lit = src.slice(i, e3);
          toks.push(mk('str', lit, ln));
          ln += (lit.match(/\n/g) || []).length; i = e3; continue;
        }
        toks.push(mk('id', word, ln)); i = j3; continue;
      }
      if (c === '"' || c === "'") {
        var triple2 = src.startsWith(c + c + c, i);
        var e4 = readString(i, c, triple2);
        var lit2 = src.slice(i, e4);
        toks.push(mk('str', lit2, ln));
        ln += (lit2.match(/\n/g) || []).length; i = e4; continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) { var e5 = readNumber(i); toks.push(mk('num', src.slice(i, e5), ln)); i = e5; continue; }
      var op = null;
      for (var oi = 0; oi < PY_OPS.length; oi++) { if (src.startsWith(PY_OPS[oi], i)) { op = PY_OPS[oi]; break; } }
      if (!op) op = c;
      toks.push(mk('op', op, ln)); i += op.length;
    }
    return { tokens: toks, errors: errs };
  }

  /* ---------------- 有意义的 token 流 ---------------- */
  // 过滤空白，附带：nlB（其前连续换行数）、spB（其前是否有水平空白）、spA（其后是否有水平空白或换行）、col（所在列）
  function sig(tokens) {
    var out = [], i = 0, n = tokens.length, col = 0;
    while (i < n) {
      var t = tokens[i];
      if (t.k === 'nl') { col = 0; i++; continue; }
      if (t.k === 'ws') { col += t.t.length; i++; continue; }
      var nlB = 0, spB = false, j = i - 1;
      while (j >= 0 && (tokens[j].k === 'ws' || tokens[j].k === 'nl')) {
        // 词法器把连续换行合并成一个 token，这里要数换行字符数才能区分「换行」与「空行」
        if (tokens[j].k === 'nl') nlB += tokens[j].t.length;
        else spB = true;
        j--;
      }
      var spA = i + 1 < n && (tokens[i + 1].k === 'ws' || tokens[i + 1].k === 'nl');
      out.push({ k: t.k, t: t.t, ln: t.ln, nlB: nlB, spB: j >= 0 ? spB || nlB > 0 : true, spA: spA, col: col, src: tokens[i] });
      if (t.t.indexOf('\n') >= 0) col = 0; else col += t.t.length;
      i++;
    }
    return out;
  }

  /* ---------------- 等价性比对 ---------------- */
  function canonComment(t) {
    if (t.charAt(0) === '/' && t.charAt(1) !== '*') return '//' + t.slice(2).replace(/\s+/g, ' ').trim();
    if (t.charAt(0) === '#') return '#' + t.slice(1).replace(/\s+/g, ' ').trim();
    var inner = t.slice(2, -2).replace(/\s+/g, ' ').trim();
    return '/*' + inner + '*/';
  }

  // C++：忽略空白与注释排版，逐个比对有意义的 token
  // #include 单独成桶（排序不改语义，故按多重集比对）
  function sigCpp(src) {
    var s = sig(lexCpp(src).tokens), seq = [], imports = [];
    for (var i = 0; i < s.length; i++) {
      var e = s[i];
      if (e.k === 'pp') {
        var p = e.t.replace(/\s+/g, ' ').trim();
        if (/^#\s*include\b/.test(p)) { imports.push(p); continue; }
        seq.push('P:' + p);
      } else if (e.k === 'lc' || e.k === 'bc') seq.push('C:' + canonComment(e.t));
      else seq.push(e.k + ':' + e.t);
    }
    return { seq: seq, imports: imports };
  }

  // import 行规范化：token 文本按固定间距拼回，附带同行的注释
  function canonImport(toks, com) {
    var s = '';
    for (var j = 0; j < toks.length; j++) {
      var t = toks[j];
      if (j > 0) {
        var p = toks[j - 1];
        var tight = (t.t === ',' || t.t === '.' || t.t === '(' || t.t === ')' || t.t === ']' || t.t === '[') ||
          (p.t === '.' || p.t === '(' || p.t === '[');
        if (p.t === 'from' && t.t === '.') tight = false;   // from .mod / from ..pkg
        if (!tight) s += ' ';
      }
      s += t.t;
    }
    return com ? s + ' |' + canonComment(com) : s;
  }
  function isPyImportLine(toks) {
    return !!(toks.length && toks[0].k === 'id' && (toks[0].t === 'import' || toks[0].t === 'from'));
  }

  // Python：语句级结构签名（缩进层级 + token）。括号内的换行不影响结构，缩进按相对层级归一化
  function pyStructure(src) {
    var toks = lexPy(src).tokens;
    var lines = [], cur = [], depth = 0, col = 0, startCol = null, cont = false, com = null, i, n = toks.length;
    function flush() {
      if (!cur.length && com === null && startCol === null) return;
      lines.push({ col: startCol === null ? 0 : startCol, toks: cur.slice(), com: com });
      cur = []; com = null; startCol = null;
    }
    for (i = 0; i < n; i++) {
      var t = toks[i];
      if (t.k === 'nl') {
        if (depth === 0 && !cont) flush();
        col = 0;
        continue;
      }
      if (t.k === 'ws') { col += t.t.length; continue; }
      if (t.k === 'cont') { cont = true; continue; }
      cont = false;
      if (startCol === null) startCol = col;
      col += t.t.length;
      if (t.k === 'op') {
        if (t.t === '(' || t.t === '[' || t.t === '{') depth++;
        else if (t.t === ')' || t.t === ']' || t.t === '}') depth = Math.max(0, depth - 1);
      }
      if (t.k === 'lc') { com = t.t; continue; }
      cur.push({ k: t.k, t: t.t });
    }
    flush();
    // 只有括号深度为 0 的语句行才参与缩进结构比对；把绝对列压成相对层级
    var stack = [-1], seq = [], imports = [], prev = 0;
    for (i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (isPyImportLine(L.toks)) { imports.push(canonImport(L.toks, L.com)); continue; }
      var c = L.col;
      if (c > prev) { stack.push(c); seq.push('+'); }
      else if (c < prev) {
        while (stack.length > 1 && stack[stack.length - 1] > c) { stack.pop(); seq.push('-'); }
        if (stack[stack.length - 1] !== c) seq.push('!');
      } else seq.push('=');
      prev = c;
      var text = [];
      for (var j = 0; j < L.toks.length; j++) text.push(L.toks[j].k + ':' + L.toks[j].t);
      if (L.com !== null) text.push('C:' + canonComment(L.com));
      if (text.length) seq.push(text.join(' '));
    }
    return { seq: seq, imports: imports };
  }

  /* ---------------- JSON ---------------- */
  function lexJson(src) {
    var toks = [], errs = [], i = 0, n = src.length, ln = 1;
    function err(msg) { errs.push({ msg: msg, ln: ln }); }
    while (i < n) {
      var c = src[i];
      if (c === '\n') { var j = i; while (j < n && src[j] === '\n') j++; toks.push(mk('nl', src.slice(i, j), ln)); ln += j - i; i = j; continue; }
      if (c === ' ' || c === '\t' || c === '\r') {
        var j2 = i; while (j2 < n && (src[j2] === ' ' || src[j2] === '\t' || src[j2] === '\r')) j2++;
        toks.push(mk('ws', src.slice(i, j2), ln)); i = j2; continue;
      }
      if (c === '"') {
        var k = i + 1, closed = false;
        while (k < n) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '"') { closed = true; k++; break; }
          if (src[k] === '\n') break;
          k++;
        }
        if (!closed) { err('未闭合的字符串'); return { tokens: toks, errors: errs }; }
        toks.push(mk('str', src.slice(i, k), ln)); i = k; continue;
      }
      if (isDigit(c) || (c === '-' && isDigit(src[i + 1]))) {
        var k2 = i + 1;
        while (k2 < n && /[0-9eE+\-.]/.test(src[k2])) k2++;
        toks.push(mk('num', src.slice(i, k2), ln)); i = k2; continue;
      }
      if (isAlpha(c)) {
        var k3 = i; while (k3 < n && isAlnum(src[k3])) k3++;
        toks.push(mk('id', src.slice(i, k3), ln)); i = k3; continue;
      }
      if ('{}[]:,'.indexOf(c) >= 0) { toks.push(mk('op', c, ln)); i++; continue; }
      err('无法识别的字符 ' + JSON.stringify(c));
      return { tokens: toks, errors: errs };
    }
    return { tokens: toks, errors: errs };
  }

  function sigJson(src) {
    var s = sig(lexJson(src).tokens), out = [];
    for (var i = 0; i < s.length; i++) out.push(s[i].k + ':' + s[i].t);
    return { seq: out, imports: [] };
  }

  /* ---------------- JavaScript / TypeScript ---------------- */
  var JS_KW = eqFold(('break case catch class const continue debugger default delete do else export extends finally for ' +
    'function if import in instanceof let new return super switch this throw try typeof var void while with yield async ' +
    'await static get set of as from enum implements interface package private protected public readonly abstract declare ' +
    'namespace type keyof infer is asserts satisfies override out in').split(' '));
  // 这些关键字后面接 ( 时不加空格（函数调用式）
  var JS_TIGHT_CALL = eqFold(('typeof instanceof void delete new in of keyof await yield').split(' '));
  var JS_OPS = ['>>>=', '===', '!==', '**=', '&&=', '||=', '??=', '>>>', '<<=', '>>=', '...', '=>', '?.', '??', '**', '==',
    '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '=>'];

  function lexJs(src) {
    var toks = [], errs = [], i = 0, n = src.length, ln = 1, prevSig = null;
    function err(msg) { errs.push({ msg: msg, ln: ln }); }
    function push(k, t) { toks.push(mk(k, t, ln)); prevSig = { k: k, t: t }; }
    function valueEnd(k, t) {
      return k === 'num' || k === 'str' || k === 'tpl' || k === 'rx' ||
        (k === 'id' && !/^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(t)) ||
        t === ')' || t === ']' || t === '}' || t === '++' || t === '--';
    }
    while (i < n) {
      var c = src[i];
      if (c === '\n') { var j = i; while (j < n && src[j] === '\n') j++; toks.push(mk('nl', src.slice(i, j), ln)); ln += j - i; i = j; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
        var j2 = i; while (j2 < n && (src[j2] === ' ' || src[j2] === '\t' || src[j2] === '\r' || src[j2] === '\f')) j2++;
        toks.push(mk('ws', src.slice(i, j2), ln)); i = j2; continue;
      }
      if (c === '/' && src[i + 1] === '/') { var e1 = i; while (e1 < n && src[e1] !== '\n') e1++; push('lc', src.slice(i, e1)); i = e1; continue; }
      if (c === '/' && src[i + 1] === '*') {
        var e2 = i + 2; while (e2 < n && !(src[e2] === '*' && src[e2 + 1] === '/')) e2++;
        if (e2 >= n) { err('未闭合的块注释'); return { tokens: toks, errors: errs }; }
        var bt = src.slice(i, e2 + 2);
        toks.push(mk('bc', bt, ln)); ln += (bt.match(/\n/g) || []).length; prevSig = { k: 'bc', t: bt }; i = e2 + 2; continue;
      }
      if (c === '"' || c === "'") {
        var k = i + 1;
        while (k < n) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === c) { k++; break; }
          if (src[k] === '\n') { err('字符串内出现未转义换行'); break; }
          k++;
        }
        if (k > n || src[k - 1] !== c) { err('未闭合的字符串'); return { tokens: toks, errors: errs }; }
        push('str', src.slice(i, k)); i = k; continue;
      }
      if (c === '`') {
        var k4 = i + 1;
        while (k4 < n) {
          if (src[k4] === '\\') { k4 += 2; continue; }
          if (src[k4] === '`') { k4++; break; }
          k4++;
        }
        if (k4 > n || src[k4 - 1] !== '`') { err('未闭合的模板字符串'); return { tokens: toks, errors: errs }; }
        var tt = src.slice(i, k4);
        toks.push(mk('tpl', tt, ln)); ln += (tt.match(/\n/g) || []).length; prevSig = { k: 'tpl', t: tt }; i = k4; continue;
      }
      if (c === '/' && !(prevSig && valueEnd(prevSig.k, prevSig.t))) {
        // 值位置上的 / 视为正则字面量
        var k5 = i + 1, inClass = false;
        while (k5 < n) {
          var ch = src[k5];
          if (ch === '\\') { k5 += 2; continue; }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { k5++; break; }
          else if (ch === '\n') { err('未闭合的正则字面量'); return { tokens: toks, errors: errs }; }
          k5++;
        }
        while (k5 < n && /[a-z]/.test(src[k5])) k5++;
        push('rx', src.slice(i, k5)); i = k5; continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
        var k6 = i;
        if (c === '0' && /[xXbBoO]/.test(src[i + 1])) { k6 = i + 2; while (k6 < n && /[0-9a-fA-F_]/.test(src[k6])) k6++; }
        else { while (k6 < n && /[0-9_]/.test(src[k6])) k6++; if (src[k6] === '.') { k6++; while (k6 < n && /[0-9_]/.test(src[k6])) k6++; } }
        if (src[k6] === 'e' || src[k6] === 'E') { k6++; if (src[k6] === '+' || src[k6] === '-') k6++; while (k6 < n && /[0-9]/.test(src[k6])) k6++; }
        if (src[k6] === 'n') k6++;
        push('num', src.slice(i, k6)); i = k6; continue;
      }
      if (isAlpha(c)) {
        var k7 = i; while (k7 < n && isAlnum(src[k7])) k7++;
        push('id', src.slice(i, k7)); i = k7; continue;
      }
      var op = null;
      for (var oi = 0; oi < JS_OPS.length; oi++) { if (src.startsWith(JS_OPS[oi], i)) { op = JS_OPS[oi]; break; } }
      if (!op) op = c;
      push('op', op); i += op.length;
    }
    return { tokens: toks, errors: errs };
  }

  function sigJs(src) {
    var s = sig(lexJs(src).tokens), out = [];
    for (var i = 0; i < s.length; i++) {
      var e = s[i];
      if (e.k === 'lc' || e.k === 'bc') out.push('C:' + canonComment(e.t));
      else out.push(e.k + ':' + e.t);
    }
    return { seq: out, imports: [] };
  }

  function equivalent(lang, a, b) {
    var pick = lang === 'py' ? pyStructure : (lang === 'json' ? sigJson : (lang === 'js' ? sigJs : sigCpp));
    var A = pick(a), B = pick(b);
    var n = Math.min(A.seq.length, B.seq.length);
    for (var i = 0; i < n; i++) {
      if (A.seq[i] !== B.seq[i]) {
        return { ok: false, msg: '第 ' + (i + 1) + ' 处标记不一致', at: A.seq[i], got: B.seq[i] };
      }
    }
    if (A.seq.length !== B.seq.length) return { ok: false, msg: 'token 数量不一致（' + A.seq.length + ' → ' + B.seq.length + '）' };
    var ia = A.imports.slice().sort(), ib = B.imports.slice().sort();
    for (i = 0; i < Math.min(ia.length, ib.length); i++) {
      if (ia[i] !== ib[i]) return { ok: false, msg: 'import/include 内容不一致', at: ia[i], got: ib[i] };
    }
    if (ia.length !== ib.length) return { ok: false, msg: 'import/include 条数不一致（' + ia.length + ' → ' + ib.length + '）' };
    return { ok: true, count: A.seq.length + A.imports.length };
  }

  // 括号配平（供 UI 快速提示）
  function balance(tokens) {
    var st = [], pairs = { '(': ')', '[': ']', '{': '}' };
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.k !== 'op') continue;
      if (t.t === '(' || t.t === '[' || t.t === '{') st.push(t);
      else if (t.t === ')' || t.t === ']' || t.t === '}') {
        var top = st.pop();
        if (!top || pairs[top.t] !== t.t) return { ok: false, msg: '括号不配平：第 ' + t.ln + ' 行 ' + t.t };
      }
    }
    if (st.length) return { ok: false, msg: '括号未闭合：第 ' + st[st.length - 1].ln + ' 行 ' + st[st.length - 1].t };
    return { ok: true };
  }

  root.FmtLex = {
    lexCpp: lexCpp, lexPy: lexPy, lexJson: lexJson, lexJs: lexJs, lex: function (lang, src) {
      return lang === 'py' ? lexPy(src) : lang === 'json' ? lexJson(src) : lang === 'js' ? lexJs(src) : lexCpp(src);
    },
    sig: sig, sigCpp: sigCpp, pyStructure: pyStructure, sigJson: sigJson, sigJs: sigJs,
    equivalent: equivalent, balance: balance, canonComment: canonComment,
    canonImport: canonImport, isPyImportLine: isPyImportLine,
    set: set, setOf: setOf,
    CPP_KW: CPP_KW, PY_KW: PY_KW, JS_KW: JS_KW, CPP_TIGHT_CALL: CPP_TIGHT_CALL, JS_TIGHT_CALL: JS_TIGHT_CALL,
    isAlpha: isAlpha, isAlnum: isAlnum, isDigit: isDigit, mk: mk
  };
})(typeof window !== 'undefined' ? window : globalThis);
