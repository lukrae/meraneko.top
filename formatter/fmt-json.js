/* JSON 格式化器：递归下降 + 结构校验
 *  - 每行一个键值对，嵌套按缩进展开，空对象 / 空数组保持单行
 *  - 字符串与数字原样输出；键必须是字符串、缺逗号 / 缺冒号 / 尾逗号都会报错并指出行号
 */
(function (root) {
  'use strict';
  var L = root.FmtLex;

  function normOpt(o) {
    o = o || {};
    return {
      indent: Math.max(1, Math.min(8, o.indent || 2)),
      useTab: !!o.useTab,
      maxBlank: 1,
      width: 100,
      wrap: false,
      align: false,
      sortImports: false
    };
  }

  function format(src, opt) {
    opt = normOpt(opt);
    var lexed = L.lexJson(src);
    var S = L.sig(lexed.tokens);
    var errors = lexed.errors.slice();
    var out = [], depth = 0, i = 0;

    function pad() { return opt.useTab ? new Array(depth + 1).join('\t') : new Array(depth * opt.indent + 1).join(' '); }
    function emit(s) { out.push(s.replace(/[ \t]+$/, '')); }
    function err(ln, msg) { if (errors.length < 6) errors.push({ msg: msg, ln: ln }); }
    function peek() { return S[i]; }
    function isOp(t) { var e = S[i]; return e && e.k === 'op' && e.t === t; }

    function scalarText(e) { return e.t; }

    function parseValue(prefix, ln) {
      var e = peek();
      if (!e) { err(ln, '缺少值'); return; }
      if (e.k === 'str' || e.k === 'num') { i++; emit(prefix + scalarText(e)); return; }
      if (e.k === 'id') {
        if (e.t === 'true' || e.t === 'false' || e.t === 'null') { i++; emit(prefix + e.t); return; }
        err(e.ln, '非法字面量 ' + e.t);
        i++; emit(prefix + e.t);
        return;
      }
      if (isOp('{')) { parseObject(prefix); return; }
      if (isOp('[')) { parseArray(prefix); return; }
      err(e.ln, '期望一个值，读到 ' + e.t);
      i++; emit(prefix + e.t);
    }

    function parseObject(prefix) {
      var open = peek();
      i++;
      if (isOp('}')) { i++; emit(prefix + '{}'); return; }
      emit(prefix + '{');
      depth++;
      var n = 0;
      while (true) {
        if (isOp('}')) { i++; break; }
        var e = peek();
        if (!e) { err(open.ln, '对象未闭合'); break; }
        if (n > 0) {
          if (isOp(',')) {
            i++;
            if (isOp('}')) { err(e.ln, '尾逗号'); i++; break; }
          } else {
            err(e.ln, '缺少逗号');
          }
        }
        n++;
        e = peek();
        if (!e) { err(open.ln, '对象未闭合'); break; }
        var keyText = '""';
        if (e.k === 'str') { keyText = e.t; i++; }
        else { err(e.ln, '键必须是字符串'); i++; }
        if (isOp(':')) i++;
        else err(e.ln, '键后面缺少 :');
        parseValue(pad() + keyText + ': ', e.ln);
        if (!isOp('}')) out[out.length - 1] += ',';
      }
      depth--;
      emit(pad() + '}');
    }

    function parseArray(prefix) {
      var open = peek();
      i++;
      if (isOp(']')) { i++; emit(prefix + '[]'); return; }
      emit(prefix + '[');
      depth++;
      var n = 0;
      while (true) {
        if (isOp(']')) { i++; break; }
        var e = peek();
        if (!e) { err(open.ln, '数组未闭合'); break; }
        if (n > 0) {
          if (isOp(',')) {
            i++;
            if (isOp(']')) { err(e.ln, '尾逗号'); i++; break; }
          } else err(e.ln, '缺少逗号');
        }
        n++;
        parseValue(pad(), e.ln);
        if (!isOp(']')) out[out.length - 1] += ',';
      }
      depth--;
      emit(pad() + ']');
    }

    parseValue('', 1);
    if (i < S.length) err(S[i].ln, '多余的内容 ' + S[i].t);

    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return {
      code: out.length ? out.join('\n') + '\n' : '',
      errors: errors.slice(0, 6),
      warnings: errors.slice(6).length ? ['还有 ' + (errors.length - 6) + ' 个问题未显示'] : []
    };
  }

  root.FmtJson = { format: format };
})(typeof window !== 'undefined' ? window : globalThis);
