import { describe, expect, test } from 'bun:test';
import { droppedImageHost, sameOriginImage } from './media';

describe('sameOriginImage', () => {
  test('the app\'s own files and inline data images are allowed', () => {
    expect(sameOriginImage('/api/files/abc')).toBe(true);
    expect(sameOriginImage('/uploads/xyz.png')).toBe(true);
    expect(sameOriginImage('data:image/png;base64,AAAA')).toBe(true);
  });

  test('anything that leaves the origin is refused', () => {
    expect(sameOriginImage('https://tracker.example/p.gif?u=1')).toBe(false);
    expect(sameOriginImage('http://192.168.1.9/x.png')).toBe(false);
    // Protocol-relative is a different host, not a path on this one.
    expect(sameOriginImage('//evil.example/x.png')).toBe(false);
    expect(sameOriginImage('javascript:alert(1)')).toBe(false);
    expect(sameOriginImage('')).toBe(false);
  });

  test('a dropped image names the host, never the URL', () => {
    expect(droppedImageHost('https://tracker.example/p.gif?u=secret')).toBe('tracker.example');
    expect(droppedImageHost('not a url')).toBe('remote');
  });
});
