/* C++ 格式化器
 *
 * 设计要点
 *  - 逐 token 输出（emit walker），缩进由花括号深度驱动，语句由 `;` / `}` 收尾换行
 *  - `{` 先分类：block（复合语句）与 init（初始化列表/表达式花括号）。分类靠前一个 token
 *    加一次括号体扫描（体里出现 `;` 或嵌套花括号 → block，否则 init），这样 `struct S{};`、
 *    `enum E{A,B};` 与 `if(x){}`、`class A{void f(){}};` 都能各自正确
 *  - 空格：明确的运算符一律规范化；`*` `&` `&&`（指针/引用与乘除无法靠词法区分）沿用源码空白，
 *    只做「一元 / 非一元」的判定；`<` `>` 先做模板尖括号配对判定，配对成功才紧贴
 *  - 预处理指令整条保留，列 0 输出，不参与重排
 *  - 括号跨行时：能在一行内放下就合并（unwrap），放不下则按一层缩进保持原换行
 */
(function (root) {
  'use strict';
  var L = root.FmtLex, LV = root.FmtLayout, SORT = root.FmtSort;

  var LIT_KW = L.setOf({ 'true': 1, 'false': 1, 'nullptr': 1, 'this': 1, 'NULL': 1 });
  // 语句开头出现这些关键字时不参与赋值对齐
  var CTRL_KW = L.setOf({
    'if': 1, 'for': 1, 'while': 1, 'switch': 1, 'case': 1, 'default': 1, 'return': 1, 'else': 1,
    'do': 1, 'try': 1, 'catch': 1, 'break': 1, 'continue': 1, 'goto': 1, 'throw': 1, 'public': 1,
    'private': 1, 'protected': 1
  });
  var ALWAYS_SPACED = L.setOf({
    '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '&=': 1, '|=': 1, '^=': 1, '==': 1, '!=': 1,
    '<=': 1, '>=': 1, '||': 1, '<<': 1, '>>': 1, '<<=': 1, '>>=': 1, '<=>': 1, '->*': 1, '+': 1, '-': 1,
    '/': 1, '%': 1, '|': 1, '^': 1, '?': 1
  });
  var JOIN_AFTER_BRACE = L.setOf({ ')': 1, ',': 1, ';': 1, ']': 1, 'else': 1, 'catch': 1, 'while': 1 });
  var INIT_TRIGGER = L.setOf({ '=': 1, ',': 1, '(': 1, '[': 1, 'return': 1, 'new': 1, 'co_return': 1, 'throw': 1 });
  var LABEL_KW = L.setOf({ 'case': 1, 'default': 1, 'public': 1, 'private': 1, 'protected': 1 });

  function normOpt(o) {
    o = o || {};
    return {
      indent: Math.max(1, Math.min(8, o.indent || 4)),
      useTab: !!o.useTab,
      brace: o.brace === 'allman' ? 'allman' : 'attach',
      elseNewline: !!o.elseNewline,
      caseIndent: !!o.caseIndent,
      maxBlank: o.maxBlank === undefined ? 1 : Math.max(0, Math.min(4, o.maxBlank)),
      width: Math.max(40, Math.min(200, o.width || 100)),
      unwrap: o.unwrap === undefined ? true : !!o.unwrap,
      wrap: o.wrap === undefined ? true : !!o.wrap,
      align: !!o.align,
      sortImports: o.sortImports === undefined ? true : !!o.sortImports
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
    if (opt.sortImports && SORT) src = SORT.sortCppIncludes(src);
    var lexed = L.lexCpp(src);
    var E = L.sig(lexed.tokens), n = E.length;
    if (!n) return { code: '', errors: lexed.errors, warnings: [] };
    var warnings = [];

    var i, j;
    var angle = [], brace = [], pdepth = [], unary = [], tightParen = [], span = [], match = [];
    for (i = 0; i < n; i++) { angle[i] = null; brace[i] = null; pdepth[i] = 0; unary[i] = false; tightParen[i] = false; span[i] = false; match[i] = -1; }

    // ---- 括号深度（() []） ----
    var d = 0;
    for (i = 0; i < n; i++) {
      pdepth[i] = d;
      if (E[i].k === 'op') {
        if (E[i].t === '(' || E[i].t === '[') d++;
        else if (E[i].t === ')' || E[i].t === ']') d = Math.max(0, d - 1);
      }
    }

    // ---- 模板尖括号配对 ----
    function angleCloseAt(start) {
      var p = E[start - 1];
      if (!p || !(p.k === 'id' || p.t === '>' || p.t === '::')) return -1;
      var dd = 1, k = start + 1;
      while (k < n) {
        var e = E[k], t = e.t;
        if (e.k === 'lc' || e.k === 'bc' || e.k === 'pp') return -1;
        if (e.k === 'op') {
          if (t === '<') dd++;
          else if (t === '>') { dd--; if (dd === 0) return k; }
          else if (t === '>>') { dd -= 2; if (dd <= 0) return k; }
          else if (t === '::' || t === ',' || t === '*' || t === '&' || t === '&&' || t === '...' || t === '[' || t === ']') { /* 允许 */ }
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

    // ---- 花括号分类 ----
    function bodyKind(start) {
      var dd = 0, hasSemi = false, hasNested = false, k = start;
      while (k < n) {
        var e = E[k];
        if (e.k === 'pp') return 'block';
        if (e.k === 'op') {
          if (e.t === '{') { dd++; if (dd > 1) hasNested = true; }
          else if (e.t === '}') { dd--; if (dd === 0) return (hasSemi || hasNested) ? 'block' : 'init'; }
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
        if (p.t === ')' || p.t === ']' || p.t === '}' || p.t === ':') return 'block';
        if (p.t === '{') return brace[k - 1] === 'init' ? 'init' : 'block';
        if (p.t === '<' && angle[k - 1] === 'open') return bodyKind(k);
        return 'init';
      }
      if (p.k === 'id' && INIT_TRIGGER[p.t]) return 'init';
      if (p.k === 'id' || p.k === 'num' || p.k === 'str' || p.k === 'chr') return bodyKind(k);
      return 'init';
    }
    var stack = [];
    for (i = 0; i < n; i++) {
      if (E[i].k !== 'op') continue;
      if (E[i].t === '{') { brace[i] = classifyBrace(i); stack.push(i); }
      else if (E[i].t === '}') {
        var oi = stack.pop();
        if (oi !== undefined) { brace[i] = brace[oi]; match[oi] = i; }
        else { brace[i] = 'block'; warnings.push('第 ' + E[i].ln + ' 行出现多余的 }'); }
      }
    }

    // ---- 一元判定 ----
    // + - ! ~ ：按「前一个 token 能不能结束表达式」判断（关键字里的 return/case 等不算结束）
    function exprEnd(k) {
      if (k < 0) return false;
      var p = E[k];
      if (p.k === 'num' || p.k === 'str' || p.k === 'chr') return true;
      if (p.k === 'id') return !L.CPP_KW[p.t] || !!LIT_KW[p.t];
      if (p.t === ')' || p.t === ']' || p.t === '++' || p.t === '--') return true;
      if (p.t === '>' && angle[k] === 'close') return true;
      return false;
    }
    // * & ：指针/引用与乘除无法靠词法区分，只有前面是运算符或左括号时才认定为一元（解引用/取地址）
    for (i = 0; i < n; i++) {
      var e0 = E[i];
      if (e0.k !== 'op') continue;
      if (e0.t === '+' || e0.t === '-' || e0.t === '!' || e0.t === '~') unary[i] = !exprEnd(i - 1);
      else if (e0.t === '*' || e0.t === '&') {
        var pu = E[i - 1];
        unary[i] = !pu || (pu.k === 'op' && !(pu.t === ')' || pu.t === ']' || pu.t === '}' || (pu.t === '>' && angle[i - 1] === 'close')));
      }
    }

    // ---- operator 重载名的紧贴括号 ----
    for (i = 0; i < n; i++) {
      if (E[i].k !== 'op' || (E[i].t !== '(' && E[i].t !== '[')) continue;
      var p1 = E[i - 1], p2 = E[i - 2];
      if ((p1 && p1.t === 'operator') || (p2 && p2.t === 'operator') || (p1 && p1.t === 'delete')) tightParen[i] = true;
    }

    // ---- 组跨度与合并可行性 ----
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
      for (var m = a; m <= b; m++) { if (E[m].k === 'pp') return 1e9; len += E[m].t.length + 1; }
      return len;
    }
    for (i = 0; i < n; i++) {
      if (E[i].k !== 'op') continue;
      var t0 = E[i].t;
      if (t0 === '(' || t0 === '[' || (t0 === '{' && brace[i] === 'init')) {
        var cc = closeIdx(i);
        if (cc > i) span[i] = scanRange(i + 1, cc, function (e) { return e.nlB >= 1; });
      }
    }

    // ================= 输出 =================
    var out = [];
    var cur = null, curLvl = 0, curIsLabel = false, curLabelCase = false;
    var indent = 0, contIndent = 0, bodyExtra = 0, ternary = 0, joinTo = -1;
    var blkDepth = 0, caseExtra = 0, caseDepth = -1;
    var prev = null, prevIdx = -1;
    var openStack = [];

    // `}` 之后是否与 else / catch / while 收在同一行
    function joinAfter(t) {
      if (opt.elseNewline && (t === 'else' || t === 'catch' || t === 'while')) return false;
      return !!JOIN_AFTER_BRACE[t];
    }

    // `)` 收尾的控制语句头（用于识别无花括号的单语句体）
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
            return !!(q && q.k === 'id' && (q.t === 'if' || q.t === 'for' || q.t === 'while'));
          }
        }
      }
      return false;
    }

    var pendingLvl = 0;
    function pad(l) { return opt.useTab ? new Array(l + 1).join('\t') : new Array(l * opt.indent + 1).join(' '); }
    function renderLine(l, ps) {
      var s = pad(l);
      for (var m = 0; m < ps.length; m++) s += ps[m].s + ps[m].t;
      return s.replace(/[ \t]+$/, '');
    }
    function beginLine(l) { if (cur === null) { cur = []; curLvl = l; } }
    function put(t, sp, kind) {
      if (cur === null) { cur = []; curLvl = pendingLvl; }
      cur.push({ s: sp ? ' ' : '', t: t, k: kind || '' });
    }
    function renderParts(ps, skipLead) {
      var s = '';
      for (var m = 0; m < ps.length; m++) {
        if (m === 0 && skipLead) s += ps[m].t;
        else s += ps[m].s + ps[m].t;
      }
      return s.replace(/[ \t]+$/, '');
    }
    function curLen() { return cur === null ? 0 : renderLine(curLvl, cur).length; }
    function emit(obj) { out.push(obj); }
    // 单赋值语句的 = 所在列（不满足条件返回 -1）
    function eqColumn(ps) {
      var dep = LV.depths(ps), idx = -1, m;
      for (m = 0; m < ps.length; m++) {
        if (ps[m].k === 'op' && ps[m].t === '=' && dep[m] === 0) {
          if (idx >= 0) return -1;
          idx = m;
        }
      }
      if (idx <= 0) return -1;
      var lastTok = ps[ps.length - 1];
      if (!(lastTok.k === 'op' && lastTok.t === ';')) return -1;
      var first = ps[0];
      if (first.k === 'id' && CTRL_KW[first.t]) return -1;
      var w = pad(curLvl).length;
      for (m = 0; m < idx; m++) w += ps[m].s.length + ps[m].t.length;
      return w + (ps[idx].s ? 1 : 0);
    }
    function endLine() {
      if (cur === null) return;
      var lv = curLvl, ps = cur;
      cur = null;
      var eq = opt.align ? eqColumn(ps) : -1;
      var text = renderLine(lv, ps);
      if (opt.wrap && text.length > opt.width && ps.length > 1) {
        var dep = LV.depths(ps);
        var breaks = LV.findBreaks(ps, dep, LV.CPP_BREAK_OPS);
        if (breaks.length) {
          var contLvl = lv + 1;
          var padCont = pad(contLvl).length;
          var segs = LV.wrapSegments({
            count: ps.length,
            breaks: breaks,
            measure: function (a, b) {
              var first = a === 0 ? pad(lv).length : padCont;
              return first + renderParts(ps.slice(a, b), a > 0).length;
            },
            availFirst: opt.width,
            availCont: opt.width
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
    function pushBlank(k) {
      for (var m = 0; m < k; m++) { if (out.length === 0) break; if (out[out.length - 1].t === '') break; out.push({ t: '', lv: 0, cont: false, eq: -1 }); }
    }
    function suppressBlank(e) {
      if (!out.length) return true;
      var lt = out[out.length - 1].t;
      if (lt === '' || e.t === '}') return true;
      var last = lt.charAt(lt.length - 1);
      return last === '{' || last === ':';
    }

    function spaceBefore(p, pi, k, e) {
      var t = e.t, pt = p.t;
      if (e.k === 'lc' || e.k === 'bc') return true;
      if (p.k === 'lc' || p.k === 'bc') return true;
      if (t === ')' || t === ']' || t === ',' || t === ';' || t === '}') return false;
      if (t === ':') return ternary > 0 || pt === ')';
      if (pt === ':') return !curIsLabel;
      if (pt === '(' || pt === '[') return false;
      if (pt === '{') return false;
      if (pt === '}') return true;
      if (pt === 'operator' && e.k === 'op') return false;
      if (t === '::' || pt === '::' || t === '.' || pt === '.' || t === '->' || pt === '->' || t === '...' || pt === '...') return false;
      if (t === '(') {
        if (tightParen[k]) return false;
        if (p.k === 'id') { return L.CPP_KW[pt] ? !L.CPP_TIGHT_CALL[pt] : false; }
        if (pt === ')' || pt === ']') return false;
        if (pt === '>') return angle[pi] === 'close' ? false : true;
        return true;
      }
      if (t === '[') {
        if (pt === 'delete') return false;
        if (p.k === 'id' || pt === ')' || pt === ']') return false;
        return true;
      }
      if (t === '{') {
        if (brace[k] === 'init') return !(pt === '(' || pt === '[' || pt === '{' || pt === ']');
        return true;
      }
      if ((t === '++' || t === '--') && (p.k === 'id' || pt === ')' || pt === ']' || pt === '>')) return false;
      if (pt === '++' || pt === '--') return false;
      if (t === '*' || t === '&' || t === '&&') {
        if (unary[k] && pt !== '*' && pt !== '&') return (pt === '(' || pt === '[' || pt === '{') ? false : true;
        return e.spB || e.nlB > 0;
      }
      if (pt === '*' || pt === '&' || pt === '&&') {
        if (unary[pi] && t !== '*' && t !== '&') return false;
        return p.spA;
      }
      if (t === '>') return angle[k] === 'close' ? false : true;
      if (t === '>>' && angle[k] === 'close') return false;
      if (t === '<') return angle[k] === 'open' ? pt === 'template' : true;
      if (pt === '<') return angle[pi] === 'open' ? false : true;
      if (pt === '>' || (pt === '>>' && angle[pi] === 'close')) return true;
      if (unary[k]) return !(pt === '(' || pt === '[' || pt === '{');
      if (unary[pi]) return false;
      if (t === '!' || t === '~') return !(pt === '(' || pt === '[' || pt === '{');
      if (pt === '!' || pt === '~') return false;
      if (ALWAYS_SPACED[t] || ALWAYS_SPACED[pt]) return true;
      return true;
    }

    for (i = 0; i < n; i++) {
      var e = E[i], t = e.t, isOp = e.k === 'op';

      if (e.k === 'pp') {
        endLine();
        if (e.nlB >= 2) pushBlank(Math.min(e.nlB - 1, opt.maxBlank));
        var pl = e.t.split('\n');
        for (j = 0; j < pl.length; j++) emit({ t: pl[j].replace(/[ \t]+$/, ''), lv: 0, cont: false, eq: -1 });
        prev = null; prevIdx = i; cur = null;
        continue;
      }

      var joined = i < joinTo;

      // 闭合括号：先出栈再定层级
      if (isOp && (t === ')' || t === ']' || (t === '}' && brace[i] === 'init'))) {
        var pop = openStack.pop();
        if (pop && pop.span) contIndent = Math.max(0, contIndent - 1);
      }
      if (isOp && t === '}' && brace[i] === 'block') {
        if (caseExtra && blkDepth === caseDepth) { caseExtra = 0; caseDepth = -1; }
        blkDepth = Math.max(0, blkDepth - 1);
        indent = Math.max(0, indent - 1);
      }

      if (cur === null && out.length) {
        var nb = joined ? 0 : e.nlB;
        if (nb >= 2 && !suppressBlank(e)) pushBlank(Math.min(nb - 1, opt.maxBlank));
      }
      if (cur !== null && !joined && contIndent > 0 && e.nlB >= 1) endLine();

      // 括号外的源码换行保留（`{` 的位置由括号风格决定，} else 之类的收尾由 JOIN_AFTER_BRACE 决定）
      if (cur !== null && !joined && e.nlB >= 1 && pdepth[i] === 0 &&
        !(isOp && t === '{' && brace[i] === 'block') &&
        !(prev && prev.t === '}' && brace[prevIdx] === 'block' && joinAfter(t))) endLine();

      // 无花括号的单语句体：源码里换行了就保留换行并加一层缩进
      if (cur === null && !joined && e.nlB >= 1 && i > 0 && !(isOp && t === '{' && brace[i] === 'block')) {
        var pv = E[i - 1];
        if ((pv.k === 'op' && pv.t === ')' && ctrlHeaderAt(i - 1)) || (pv.k === 'id' && (pv.t === 'else' || pv.t === 'do'))) bodyExtra = 1;
      }

      var lv = indent + contIndent + bodyExtra;
      if (cur === null) {
        curIsLabel = false;
        curLabelCase = false;
        if (LABEL_KW[t]) { curIsLabel = true; curLabelCase = (t === 'case' || t === 'default'); }
        else if (e.k === 'id' && E[i + 1] && E[i + 1].k === 'op' && E[i + 1].t === ':' && pdepth[i] === 0) curIsLabel = true;
      }
      if (!curIsLabel) lv += caseExtra;
      else if (curLabelCase) { caseExtra = opt.caseIndent ? 1 : 0; caseDepth = blkDepth; }
      if (curIsLabel && !(curLabelCase && opt.caseIndent)) lv = Math.max(0, lv - 1);
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

      // 括号状态
      if (isOp) {
        if (t === '(' || t === '[' || (t === '{' && brace[i] === 'init')) {
          var cl = closeIdx(i);
          var spans = span[i];
          var jn = false;
          if (opt.unwrap && spans && cl > i && !scanRange(i + 1, cl, function (x) { return x.k === 'lc' || x.k === 'bc' || x.k === 'pp'; })) {
            if (curLen() + flatLen(i, cl) <= opt.width) jn = true;
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

      // 换行策略
      var nl = false;
      var nx = E[i + 1];
      if (e.k === 'lc') nl = true;
      else if (e.k === 'bc') nl = !!(nx && nx.nlB >= 1);
      else if (isOp && t === ';') nl = pdepth[i] === 0;
      else if (isOp && t === '{') nl = brace[i] === 'block';
      else if (isOp && t === '}') nl = brace[i] === 'block' ? !(nx && joinAfter(nx.t)) : !!(nx && i + 1 >= joinTo && nx.nlB >= 1);
      else if (isOp && t === ':' && curIsLabel) nl = true;
      if (nl) endLine();

      // 单语句体的缩进在语句收尾处结束
      if (isOp && ((t === ';' && pdepth[i] === 0) || t === '{' || (t === '}' && brace[i] === 'block'))) bodyExtra = 0;

      prev = e; prevIdx = i;
    }
    endLine();
    if (opt.align) LV.alignRows(out);
    while (out.length && out[out.length - 1].t.trim() === '') out.pop();
    while (out.length && out[0].t.trim() === '') out.shift();
    var lines = [];
    for (i = 0; i < out.length; i++) lines.push(out[i].t);
    return { code: lines.length ? lines.join('\n') + '\n' : '', errors: lexed.errors, warnings: warnings };
  }

  root.FmtCpp = { format: format };
})(typeof window !== 'undefined' ? window : globalThis);
