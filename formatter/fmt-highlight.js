/* 语法高亮：复用 FmtLex 的词法结果，token 文本原样拼回，保证覆盖层与 textarea 逐字对齐
 *   - highlight(lang, src) → 整段 HTML
 *   - lines(lang, src)     → 逐行 HTML 数组（跨行 token 会在每行重新包裹，便于标改动行）
 */
(function (root) {
  'use strict';
  var L = root.FmtLex;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function classify(lang, toks) {
    var K = lang === 'py' ? L.PY_KW : lang === 'js' ? L.JS_KW : lang === 'json' ? null : L.CPP_KW;
    var cls = new Array(toks.length), i, j;
    for (i = 0; i < toks.length; i++) {
      var t = toks[i];
      switch (t.k) {
        case 'lc': case 'bc': cls[i] = 'c'; break;
        case 'pp': cls[i] = 'p'; break;
        case 'str': case 'chr': case 'tpl': cls[i] = 's'; break;
        case 'rx': cls[i] = 'r'; break;
        case 'num': cls[i] = 'n'; break;
        case 'op': case 'cont': cls[i] = 'o'; break;
        case 'id':
          if (lang === 'json') cls[i] = (t.t === 'true' || t.t === 'false' || t.t === 'null') ? 'k' : 'i';
          else if (K && K[t.t]) cls[i] = 'k';
          else if (/^[A-Z]/.test(t.t)) cls[i] = 't';
          else cls[i] = 'i';
          break;
        default: cls[i] = null;
      }
    }
    for (i = 0; i < toks.length; i++) {
      if (cls[i] !== 'i') continue;
      j = i + 1;
      while (j < toks.length && toks[j].k === 'ws') j++;
      if (toks[j] && toks[j].k === 'op' && toks[j].t === '(') cls[i] = 'f';
      else if (lang === 'json' && toks[j] && toks[j].k === 'op' && toks[j].t === ':') cls[i] = 't';
    }
    // JSON 的键（字符串 + 冒号）用类型色
    if (lang === 'json') {
      for (i = 0; i < toks.length; i++) {
        if (toks[i].k !== 'str') continue;
        j = i + 1;
        while (j < toks.length && toks[j].k === 'ws') j++;
        if (toks[j] && toks[j].k === 'op' && toks[j].t === ':') cls[i] = 't';
      }
    }
    return cls;
  }

  function tokensFor(lang, src) {
    var lex = L.lex(lang, src);
    var toks = lex.tokens, cls = classify(lang, toks);
    var acc = '';
    for (var i = 0; i < toks.length; i++) acc += toks[i].t;
    return { toks: toks, cls: cls, ok: acc === src };
  }

  function highlight(lang, src) {
    if (!src) return '';
    var r = tokensFor(lang, src);
    if (!r.ok) return esc(src);
    var out = '';
    for (var i = 0; i < r.toks.length; i++) {
      var t = r.toks[i];
      if (!r.cls[i]) out += esc(t.t);
      else out += '<span class="h' + r.cls[i] + '">' + esc(t.t) + '</span>';
    }
    return out;
  }

  // 逐行 HTML：跨行 token（块注释 / 多行字符串）会在每行独立包裹
  function lines(lang, src) {
    var r = tokensFor(lang, src);
    if (!r.ok) return { ok: false, html: src.split('\n').map(esc) };
    var res = [''], ln = 0;
    function put(text, c) {
      var parts = text.split('\n');
      for (var p = 0; p < parts.length; p++) {
        if (p > 0) { ln++; res.push(''); }
        if (!parts[p]) continue;
        res[ln] += c ? '<span class="h' + c + '">' + esc(parts[p]) + '</span>' : esc(parts[p]);
      }
    }
    for (var i = 0; i < r.toks.length; i++) put(r.toks[i].t, r.cls[i]);
    return { ok: true, html: res };
  }

  root.FmtHL = { highlight: highlight, lines: lines, esc: esc, tokensFor: tokensFor };
})(typeof window !== 'undefined' ? window : globalThis);
