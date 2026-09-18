/* JavaScript / TypeScript 格式化器
 *
 * 设计要点
 *  - 忠实保留源码语句级换行：JS 有 ASI（自动分号插入），把 `return` 与下一行合并会改变语义，
 *    所以只在括号内做合并/折行，语句之间一律沿用作者的换行
 *  - `{` 区分 block（函数体 / if / class…）与 object（字面量 / 类型字面量）：对象字面量若源码里
 *    紧随 `{` 就换了行，则保持多行（对齐 Prettier 的直觉），否则能放一行就放一行
 *  - 正则字面量与除号靠「前一个 token 能否结束值」区分；模板串整块保留，内部不动
 *  - TS 的泛型尖括号沿用 C++ 那套配对扫描；`case` 默认缩进一层（与 Prettier 一致）
 */
(function (root) {
  'use strict';
  var L = root.FmtLex, LV = root.FmtLayout;

  var LIT_KW = L.setOf({ 'true': 1, 'false': 1, 'null': 1, 'undefined': 1, 'this': 1, 'NaN': 1, 'Infinity': 1 });
  var CTRL_KW = L.setOf({
    'if': 1, 'for': 1, 'while': 1, 'switch': 1, 'case': 1, 'default': 1, 'return': 1, 'else': 1,
    'do': 1, 'try': 1, 'catch': 1, 'finally': 1, 'break': 1, 'continue': 1, 'throw': 1, 'class': 1,
    'interface': 1, 'enum': 1, 'namespace': 1, 'declare': 1, 'abstract': 1, 'type': 1, 'export': 1, 'import': 1
  });
  var BLOCK_HEAD = L.setOf({ 'class': 1, 'interface': 1, 'enum': 1, 'namespace': 1, 'declare': 1, 'abstract': 1 });
  var JOIN_AFTER_BRACE = L.setOf({ ')': 1, ',': 1, ';': 1, ']': 1, 'else': 1, 'catch': 1, 'finally': 1, 'while': 1 });
  var LABEL_KW_JS = L.setOf({ 'case': 1, 'default': 1 });

  function normOpt(o) {
    o = o || {};
    return {
      indent: Math.max(1, Math.min(8, o.indent || 2)),
      useTab: !!o.useTab,
      brace: o.brace === 'allman' ? 'allman' : 'attach',
      elseNewline: !!o.elseNewline,
      caseIndent: o.caseIndent === undefined ? true : !!o.caseIndent,
      maxBlank: o.maxBlank === undefined ? 1 : Math.max(0, Math.min(4, o.maxBlank)),
      width: Math.max(40, Math.min(200, o.width || 100)),
      unwrap: o.unwrap === undefined ? true : !!o.unwrap,
      wrap: o.wrap === undefined ? true : !!o.wrap,
      align: !!o.align
    };
  }

  function fmtLineComment(t) {
    var body = t.slice(2).replace(/\s+$/, '');
    if (body === '') return '//';
    if (/^[ \t]/.test(body)) return '//' + body.replace(/^[ \t]+/, ' ');
    if (/^[A-Za-z0-9\u4e00-\u9fff]/.test(body)) return '// ' + body;
    return '//' + body;
  }

  function format(src, opt) {
    opt = normOpt(opt);
    var lexed = L.lexJs(src);
    var E = L.sig(lexed.tokens), n = E.length;
    if (!n) return { code: '', errors: lexed.errors, warnings: [] };
    var warnings = [];
    var i, j;
    var angle = [], brace = [], pdepth = [], unary = [], tightParen = [], span = [], match = [], objMulti = [];
    for (i = 0; i < n; i++) { angle[i] = null; brace[i] = null; pdepth[i] = 0; unary[i] = false; tightParen[i] = false; span[i] = false; match[i] = -1; objMulti[i] = false; }

    var d = 0;
    for (i = 0; i < n; i++) {
      pdepth[i] = d;
      if (E[i].k === 'op') {
        if (E[i].t === '(' || E[i].t === '[') d++;
        else if (E[i].t === ')' || E[i].t === ']') d = Math.max(0, d - 1);
      }
    }

    // 泛型 / 类型参数尖括号配对（沿用 C++ 的启发式）
    function angleCloseAt(start) {
      var p = E[start - 1];
      if (!p || !(p.k === 'id' || p.t === '>' || p.t === '::')) return -1;
      var dd = 1, k = start + 1;
      while (k < n) {
        var e = E[k], t = e.t;
        if (e.k === 'lc' || e.k === 'bc') return -1;
        if (e.k === 'op') {
          if (t === '<') dd++;
          else if (t === '>') { dd--; if (dd === 0) return k; }
          else if (t === '>>') { dd -= 2; if (dd <= 0) return k; }
          else if (t === '::' || t === ',' || t === '...' || t === '[' || t === ']' || t === '|' || t === '&') { /* 允许 */ }
          else return -1;
        } else if (e.k !== 'id' && e.k !== 'num') return -1;
        k++;
      }
      return -1;
    }
    for (i = 0; i < n; i++) {
      if (E[i].k === 'op' && E[i].t === '<') {
        var c = angleCloseAt(i);
        if (c > 0) { angle[i] = 'open'; angle[c] = 'close'; }
      }
    }

    function bodyKind(start) {
      var dd = 0, hasSemi = false, hasNested = false, k = start;
      while (k < n) {
        var e = E[k];
        if (e.k === 'op') {
          if (e.t === '{') { dd++; if (dd > 1) hasNested = true; }
          else if (e.t === '}') { dd--; if (dd === 0) return (hasSemi || hasNested) ? 'block' : 'object'; }
          else if (e.t === ';' && dd === 1) hasSemi = true;
        }
        k++;
      }
      return 'block';
    }
    function classifyBrace(k) {
      var p = E[k - 1];
      if (!p) return 'block';
      if (p.k === 'op') {
        if (p.t === ')') return 'block';
        if (p.t === '}') return 'block';
        if (p.t === ';') return 'block';
        if (p.t === '{') return brace[k - 1] === 'object' ? 'object' : 'block';
        if (p.t === '=>') return 'block';
        if (p.t === ']') return 'object';
        return 'object';   // = , ( [ : ? 等表达式位置
      }
      if (p.k === 'id') {
        if (p.t === 'else' || p.t === 'do' || p.t === 'try' || p.t === 'finally') return 'block';
        if (BLOCK_HEAD[p.t]) return 'block';
        var p2 = E[k - 2];
        if (p2 && p2.k === 'id' && BLOCK_HEAD[p2.t]) return 'block';
        return bodyKind(k);
      }
      return 'object';
    }
    var stack = [];
    for (i = 0; i < n; i++) {
      if (E[i].k !== 'op') continue;
      if (E[i].t === '{') {
        brace[i] = classifyBrace(i);
        stack.push(i);
      } else if (E[i].t === '}') {
        var oi = stack.pop();
        if (oi !== undefined) { brace[i] = brace[oi]; match[oi] = i; }
        else { brace[i] = 'block'; warnings.push('第 ' + E[i].ln + ' 行出现多余的 }'); }
      }
    }
    // 对象字面量：源码里 `{` 后紧跟换行 → 保持多行
    for (i = 0; i < n; i++) {
      if (brace[i] === 'object' && E[i + 1] && E[i + 1].nlB >= 1) objMulti[i] = true;
    }

    function exprEnd(k) {
      if (k < 0) return false;
      var p = E[k];
      if (p.k === 'num' || p.k === 'str' || p.k === 'tpl' || p.k === 'rx') return true;
      if (p.k === 'id') return !L.JS_KW[p.t] || !!LIT_KW[p.t];
      if (p.t === ')' || p.t === ']' || p.t === '++' || p.t === '--') return true;
      if (p.t === '>' && angle[k] === 'close') return true;
      return false;
    }
    for (i = 0; i < n; i++) {
      var e0 = E[i];
      if (e0.k !== 'op') continue;
      if (e0.t === '+' || e0.t === '-' || e0.t === '!' || e0.t === '~') unary[i] = !exprEnd(i - 1);
      else if (e0.t === '*') {
        var pu = E[i - 1];
        unary[i] = !(pu && pu.k === 'id' && (pu.t === 'function' || pu.t === 'yield'));
      }
    }
    for (i = 0; i < n; i++) {
      if (E[i].k !== 'op' || (E[i].t !== '(' && E[i].t !== '[')) continue;
      var p1 = E[i - 1], p2 = E[i - 2];
      if (p1 && p1.t === 'typeof') tightParen[i] = true;
      if (p2 && p2.t === 'function') tightParen[i] = true;
    }

    function closeIdx(k) {
      if (E[k].t === '{') return match[k];
      var dd = 0;
      for (var m = k; m < n; m++) {
        var e = E[m];
        if (e.k !== 'op') continue;
        if (e.t === '(' || e.t === '[') dd++;
        else if (e.t === ')' || e.t === ']') { dd--; if (dd === 0) return m; }
      }
      return -1;
    }
    function scanRange(a, b, fn) {
      for (var m = a; m <= b; m++) { if (fn(E[m], m)) return true; }
      return false;
    }
    function flatLen(a, b) {
      var len = 0;
      for (var m = a; m <= b; m++) len += E[m].t.length + 1;
      return len;
    }
    for (i = 0; i < n; i++) {
      if (E[i].k !== 'op') continue;
      var t0 = E[i].t;
      if (t0 === '(' || t0 === '[' || (t0 === '{' && brace[i] === 'object')) {
        var cc = closeIdx(i);
        if (cc > i) span[i] = scanRange(i + 1, cc, function (e) { return e.nlB >= 1; });
      }
    }

    // ================= 输出 =================
    var out = [], cur = null, curLvl = 0, curIsLabel = false, curLabelCase = false;
    var indent = 0, contIndent = 0, bodyExtra = 0, ternary = 0, joinTo = -1;
    var blkDepth = 0, caseExtra = 0, caseDepth = -1, prev = null, prevIdx = -1, openStack = [];
    var pendingLvl = 0;

    function pad(l) { return opt.useTab ? new Array(l + 1).join('\t') : new Array(l * opt.indent + 1).join(' '); }
    function renderParts(ps, skipLead) {
      var s = '';
      for (var m = 0; m < ps.length; m++) {
        if (m === 0 && skipLead) s += ps[m].t;
        else s += ps[m].s + ps[m].t;
      }
      return s.replace(/[ \t]+$/, '');
    }
    function renderLine(l, ps) { return pad(l) + renderParts(ps); }
    function beginLine(l) { if (cur === null) { cur = []; curLvl = l; } }
    function put(t, sp, kind) {
      if (cur === null) { cur = []; curLvl = pendingLvl; }
      cur.push({ s: sp ? ' ' : '', t: t, k: kind || '' });
    }
    function emit(o) { out.push(o); }
    function endLine() {
      if (cur === null) return;
      var lv = curLvl, ps = cur;
      cur = null;
      var eq = opt.align ? eqColumn(ps, lv) : -1;
      var text = renderLine(lv, ps);
      if (opt.wrap && text.length > opt.width && ps.length > 1) {
        var dep = LV.depths(ps);
        var breaks = LV.findBreaks(ps, dep, LV.JS_BREAK_OPS);
        if (breaks.length) {
          var contLvl = lv + 1, padCont = pad(contLvl).length;
          var segs = LV.wrapSegments({
            count: ps.length, breaks: breaks,
            measure: function (a, b) {
              var first = a === 0 ? pad(lv).length : padCont;
              return first + renderParts(ps.slice(a, b), a > 0).length;
            },
            availFirst: opt.width, availCont: opt.width
          });
          for (var s2 = 0; s2 < segs.length; s2++) {
            var f = segs[s2].from, t2 = segs[s2].to;
            var lvl2 = f === 0 ? lv : contLvl;
            emit({ t: pad(lvl2) + renderParts(ps.slice(f, t2), f > 0), lv: lvl2, cont: f > 0, eq: f === 0 ? eq : -1 });
          }
          return;
        }
      }
      emit({ t: text, lv: lv, cont: false, eq: eq });
    }
    function eqColumn(ps, lv) {
      var dep = LV.depths(ps), idx = -1, m;
      for (m = 0; m < ps.length; m++) {
        if (ps[m].k === 'op' && ps[m].t === '=' && dep[m] === 0) { if (idx >= 0) return -1; idx = m; }
      }
      if (idx <= 0) return -1;
      var lastTok = ps[ps.length - 1];
      if (!(lastTok.k === 'op' && (lastTok.t === ';' || lastTok.t === ','))) return -1;
      if (ps[0].k === 'id' && CTRL_KW[ps[0].t]) return -1;
      var w = pad(lv).length;
      for (m = 0; m < idx; m++) w += ps[m].s.length + ps[m].t.length;
      return w + (ps[idx].s ? 1 : 0);
    }
    function pushBlank(k) {
      for (var m = 0; m < k; m++) { if (!out.length || out[out.length - 1].t === '') break; out.push({ t: '', lv: 0, cont: false, eq: -1 }); }
    }
    function suppressBlank(e) {
      if (!out.length) return true;
      var lt = out[out.length - 1].t;
      if (lt === '' || e.t === '}') return true;
      var last = lt.charAt(lt.length - 1);
      return last === '{' || last === ':';
    }
    function joinAfter(t) {
      if (opt.elseNewline && (t === 'else' || t === 'catch' || t === 'finally' || t === 'while')) return false;
      return !!JOIN_AFTER_BRACE[t];
    }
    function ctrlHeaderAt(k) {
      var dd = 0;
      for (var m = k; m >= 0; m--) {
        var x = E[m];
        if (x.k !== 'op') continue;
        if (x.t === ')') dd++;
        else if (x.t === '(') {
          dd--;
          if (dd === 0) {
            var q = E[m - 1];
            return !!(q && q.k === 'id' && (q.t === 'if' || q.t === 'for' || q.t === 'while' || q.t === 'switch'));
          }
        }
      }
      return false;
    }

    function spaceBefore(p, pi, k, e) {
      var t = e.t, pt = p.t;
      if (e.k === 'lc' || e.k === 'bc') return true;
      if (p.k === 'lc' || p.k === 'bc') return true;
      if (t === ')' || t === ']' || t === ',' || t === ';' || t === '}') return false;
      if (t === ':') return ternary > 0;
      if (pt === ':') return true;
      if (pt === '(' || pt === '[') return false;
      if (pt === '{') return false;
      if (pt === '}') return true;
      if (pt === '...') return false;
      if (t === '...') return false;
      if (t === '::' || pt === '::' || t === '.' || pt === '.' || t === '?.' || pt === '?.') return false;
      if (t === '(') {
        if (tightParen[k]) return false;
        if (p.k === 'id') return L.JS_KW[pt] ? !L.JS_TIGHT_CALL[pt] : false;
        if (pt === ')' || pt === ']' || pt === '>') return false;
        return true;
      }
      if (t === '[') {
        if (p.k === 'id') return (L.JS_KW[pt] && pt !== 'this' && pt !== 'super') ? true : false;
        if (pt === ')' || pt === ']' || pt === '>') return false;
        return true;
      }
      if (t === '{') {
        if (brace[k] === 'object') return !(pt === '(' || pt === '[' || pt === '{' || pt === ']');
        return true;
      }
      if ((t === '++' || t === '--') && (p.k === 'id' || pt === ')' || pt === ']')) return false;
      if (pt === '++' || pt === '--') return false;
      if (t === '*' && pt === 'function') return false;
      if (pt === '*' && E[pi] && E[pi - 1] && E[pi - 1].t === 'function') return false;
      if (t === '>') return angle[k] === 'close' ? false : true;
      if (t === '>>' && angle[k] === 'close') return false;
      if (t === '<') return angle[k] === 'open' ? pt === 'template' : true;
      if (pt === '<') return angle[pi] === 'open' ? false : true;
      if (pt === '>' || (pt === '>>' && angle[pi] === 'close')) return true;
      if (unary[k]) return !(pt === '(' || pt === '[' || pt === '{');
      if (unary[pi]) return false;
      if (t === '!' || t === '~') return !(pt === '(' || pt === '[' || pt === '{');
      if (pt === '!' || pt === '~') return false;
      return true;
    }

    for (i = 0; i < n; i++) {
      var e = E[i], t = e.t, isOp = e.k === 'op';
      var joined = i < joinTo;

      if (isOp && (t === ')' || t === ']' || (t === '}' && brace[i] === 'object'))) {
        var pop = openStack.pop();
        if (pop && pop.span) contIndent = Math.max(0, contIndent - 1);
      }
      if (isOp && t === '}' && brace[i] === 'block') {
        if (caseExtra && blkDepth === caseDepth) { caseExtra = 0; caseDepth = -1; }
        blkDepth = Math.max(0, blkDepth - 1);
        indent = Math.max(0, indent - 1);
        // JS 可以省略分号，块尾的 } 必须自己另起一行
        if (cur !== null && cur.length) endLine();
      }

      if (cur === null && out.length) {
        var nb = joined ? 0 : e.nlB;
        if (nb >= 2 && !suppressBlank(e)) pushBlank(Math.min(nb - 1, opt.maxBlank));
      }
      if (cur !== null && !joined && contIndent > 0 && e.nlB >= 1) endLine();
      if (cur !== null && !joined && e.nlB >= 1 && pdepth[i] === 0 &&
        !(isOp && t === '{' && brace[i] === 'block') &&
        !(prev && prev.t === '}' && brace[prevIdx] === 'block' && joinAfter(t))) endLine();

      if (cur === null && !joined && e.nlB >= 1 && i > 0 && !(isOp && t === '{' && brace[i] === 'block')) {
        var pv = E[i - 1];
        if ((pv.k === 'op' && pv.t === ')' && ctrlHeaderAt(i - 1)) || (pv.k === 'id' && (pv.t === 'else' || pv.t === 'do'))) bodyExtra = 1;
      }

      var lv = indent + contIndent + bodyExtra;
      if (cur === null) {
        curIsLabel = false;
        curLabelCase = false;
        if (LABEL_KW_JS[t]) { curIsLabel = true; curLabelCase = (t === 'case' || t === 'default'); }
        if (curIsLabel && !(curLabelCase && opt.caseIndent)) lv = Math.max(0, lv - 1);
      }
      if (!curIsLabel) lv += caseExtra;
      else if (curLabelCase) { caseExtra = opt.caseIndent ? 1 : 0; caseDepth = blkDepth; }
      pendingLvl = lv;
      if (cur === null) beginLine(lv);

      if (isOp && t === '{' && brace[i] === 'block' && opt.brace === 'allman' && cur !== null && cur.length) endLine();

      var spB = cur !== null && cur.length ? (e.k === 'lc' || e.k === 'bc' ? true : spaceBefore(prev, prevIdx, i, e)) : false;

      if (e.k === 'bc') {
        var bl = t.split('\n');
        var baseL = curLvl;
        put(bl[0].replace(/[ \t]+$/, ''), spB, 'bc');
        for (j = 1; j < bl.length; j++) {
          var body = bl[j].replace(/[ \t]+$/, '');
          endLine();
          emit({ t: body.trim() === '' ? '' : pad(baseL) + ' ' + body.trim(), lv: baseL, cont: false, eq: -1 });
        }
      } else if (e.k === 'lc') {
        put(fmtLineComment(t), spB, 'lc');
      } else {
        put(t, spB, e.k);
      }

      if (isOp) {
        if (t === '(' || t === '[' || (t === '{' && brace[i] === 'object')) {
          var cl = closeIdx(i);
          var spans = span[i];
          var jn = false;
          if (opt.unwrap && spans && cl > i && !objMulti[i] && !scanRange(i + 1, cl, function (x) { return x.k === 'lc' || x.k === 'bc'; })) {
            if (curLenSafe(lv) + flatLen(i, cl) <= opt.width) jn = true;
          }
          openStack.push({ span: spans && !jn });
          if (spans && !jn) contIndent++;
          if (jn) joinTo = Math.max(joinTo, cl + 1);
        }
        if (t === '{' && brace[i] === 'block') { indent++; blkDepth++; }
        if (t === '?') ternary++;
        if (t === ':') { if (ternary > 0) ternary--; }
        if (t === ';' || (t === '}' && brace[i] === 'block') || (t === '{' && brace[i] === 'block')) ternary = 0;
      }

      var nl = false, nx = E[i + 1];
      if (e.k === 'lc') nl = true;
      else if (e.k === 'bc') nl = !!(nx && nx.nlB >= 1);
      else if (isOp && t === ';') nl = pdepth[i] === 0;
      else if (isOp && t === '{') nl = brace[i] === 'block';
      else if (isOp && t === '}') nl = brace[i] === 'block' ? !(nx && joinAfter(nx.t)) : !!(nx && i + 1 >= joinTo && nx.nlB >= 1);
      else if (isOp && t === ':' && curIsLabel) nl = true;
      if (nl) endLine();

      if (isOp && ((t === ';' && pdepth[i] === 0) || t === '{' || (t === '}' && brace[i] === 'block'))) bodyExtra = 0;
      prev = e; prevIdx = i;
    }
    function curLenSafe(l) { return cur === null ? 0 : renderLine(l, cur).length; }
    endLine();
    if (opt.align) LV.alignRows(out);
    while (out.length && out[out.length - 1].t.trim() === '') out.pop();
    while (out.length && out[0].t.trim() === '') out.shift();
    var res = [];
    for (i = 0; i < out.length; i++) res.push(out[i].t);
    return { code: res.length ? res.join('\n') + '\n' : '', errors: lexed.errors, warnings: warnings };
  }

  root.FmtJs = { format: format };
})(typeof window !== 'undefined' ? window : globalThis);
