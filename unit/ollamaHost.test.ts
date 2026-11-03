import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaUrl, isLocalOllama } from '../utils/ollamaHost';

test('empty OLLAMA_HOST means this PC with the default port', () => {
  assert.equal(ollamaUrl(''), 'http://localhost:11434');
  assert.equal(ollamaUrl(undefined), 'http://localhost:11434');
  assert.equal(isLocalOllama(''), true);
});

test('every accepted form of a shared host gets a scheme and a port', () => {
  assert.equal(ollamaUrl('http://10.0.0.5:11434'), 'http://10.0.0.5:11434');
  assert.equal(ollamaUrl('10.0.0.5:11434'), 'http://10.0.0.5:11434');
  assert.equal(ollamaUrl('10.0.0.5'), 'http://10.0.0.5:11434');
  assert.equal(ollamaUrl('qa-pc-01'), 'http://qa-pc-01:11434');
  assert.equal(ollamaUrl('"http://qa-pc-01:11500/"'), 'http://qa-pc-01:11500');
  assert.equal(ollamaUrl('https://ollama.example.com'), 'https://ollama.example.com:11434');
});

test('0.0.0.0 (what a server sets to listen everywhere) is this PC, not a remote address', () => {
  assert.equal(ollamaUrl('0.0.0.0:11434'), 'http://localhost:11434');
  assert.equal(isLocalOllama('0.0.0.0:11434'), true);
});

test('local or shared', () => {
  for (const v of ['localhost', 'http://127.0.0.1:11434', 'localhost:11500', 'http://[::1]:11434']) assert.equal(isLocalOllama(v), true, v);
  for (const v of ['10.0.0.5', 'http://qa-pc-01:11434', '127.0.0.2:11500', 'https://ollama.example.com']) assert.equal(isLocalOllama(v), false, v);
});
