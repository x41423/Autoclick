import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../autoclick/utils/escape.js';

describe('escapeHtml', () => {
  test('转义 < > & " \'', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('"double"'), '&quot;double&quot;');
    assert.equal(escapeHtml("'single'"), '&#39;single&#39;');
  });

  test('普通文本原样返回', () => {
    assert.equal(escapeHtml('普通脚本名 123'), '普通脚本名 123');
  });

  test('空值安全处理', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml('0'), '0');
  });
});