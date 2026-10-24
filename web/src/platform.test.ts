import { expect, test } from 'bun:test';
import { isIOS } from './platform';

const nav = (userAgent: string, platform: string, maxTouchPoints: number) => ({ userAgent, platform, maxTouchPoints });

test('iPhone, iPad and iPod user agents get the install guidance', () => {
  expect(isIOS(nav('Mobile/23A341 iPhone', 'iPhone', 5))).toBe(true);
  expect(isIOS(nav('Mobile/23A341 iPad', 'iPad', 5))).toBe(true);
  expect(isIOS(nav('Mobile/23A341 iPod', 'iPod', 5))).toBe(true);
});

test('desktop-class iPadOS is still recognized as iOS', () => {
  expect(isIOS(nav('Macintosh; Intel Mac OS X 10_15_7', 'MacIntel', 5))).toBe(true);
});

test('a touch-screen Mac or ordinary desktop is not mistaken for iOS', () => {
  expect(isIOS(nav('Macintosh; Intel Mac OS X 10_15_7', 'MacIntel', 0))).toBe(false);
  expect(isIOS(nav('Windows NT 10.0', 'Win32', 10))).toBe(false);
});
