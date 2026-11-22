import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitWindowBounds, windowMinimum } from '../src/electron/window-fit.js';

const largeArea = { x: 100, y: 40, width: 1920, height: 1080 };

test('windowMinimum keeps the 1120x720 minimum when the work area allows it', () => {
  assert.deepEqual(windowMinimum(largeArea), [1120, 720]);
});

test('windowMinimum lowers each minimum only for a smaller work area dimension', () => {
  assert.deepEqual(windowMinimum({ ...largeArea, width: 1024 }), [1024, 720]);
  assert.deepEqual(windowMinimum({ ...largeArea, height: 640 }), [1120, 640]);
  assert.deepEqual(windowMinimum({ ...largeArea, width: 1024, height: 640 }), [1024, 640]);
});

test('fitWindowBounds fills a 1024x640 work area with clamped minimums and bounds', () => {
  const area = { x: -1024, y: 25, width: 1024, height: 640 };
  assert.deepEqual(windowMinimum(area), [1024, 640]);
  assert.deepEqual(fitWindowBounds({ x: 50, y: -100, width: 1280, height: 980 }, area), area);
});

test('fitWindowBounds preserves a fitting window already inside the work area', () => {
  const bounds = { x: 130, y: 120, width: 1280, height: 820 };
  assert.deepEqual(fitWindowBounds(bounds, largeArea), bounds);
});

test('fitWindowBounds brings partly off-screen fitting windows inside on either edge', () => {
  // The helper always clamps position. Native moved handling preserves a user
  // drag beyond an edge by skipping this helper when the display and size fit.
  assert.deepEqual(
    fitWindowBounds({ x: 50, y: 10, width: 1280, height: 820 }, largeArea),
    { x: 100, y: 40, width: 1280, height: 820 },
  );
  assert.deepEqual(
    fitWindowBounds({ x: 900, y: 400, width: 1280, height: 820 }, largeArea),
    { x: 740, y: 300, width: 1280, height: 820 },
  );
});

test('fitWindowBounds shrinks an oversized window into a work area on a negative-coordinate display', () => {
  const area = { x: -1600, y: -900, width: 1600, height: 900 };
  assert.deepEqual(fitWindowBounds({ x: 800, y: 100, width: 2000, height: 1200 }, area), area);
});

test('fitWindowBounds shrinks only the oversized dimension and preserves the fitting dimension', () => {
  assert.deepEqual(
    fitWindowBounds({ x: 130, y: 120, width: 2200, height: 820 }, largeArea),
    { x: 100, y: 120, width: 1920, height: 820 },
  );
  assert.deepEqual(
    fitWindowBounds({ x: 130, y: 120, width: 1280, height: 1200 }, largeArea),
    { x: 130, y: 40, width: 1280, height: 1080 },
  );
});

test('fitWindowBounds raises undersized windows to the allowed minimum', () => {
  assert.deepEqual(
    fitWindowBounds({ x: 130, y: 120, width: 900, height: 600 }, largeArea),
    { x: 130, y: 120, width: 1120, height: 720 },
  );
});

test('fitWindowBounds centers omitted x and y relative to the work area origin', () => {
  const area = { x: -1919, y: 31, width: 1919, height: 1079 };
  assert.deepEqual(
    fitWindowBounds({ width: 1280, height: 820 }, area),
    { x: -1599, y: 161, width: 1280, height: 820 },
  );
});

test('fitWindowBounds centers only the omitted coordinate and preserves an explicit zero', () => {
  const area = { x: -400, y: -100, width: 1920, height: 1080 };
  assert.deepEqual(
    fitWindowBounds({ x: 0, width: 1280, height: 820 }, area),
    { x: 0, y: 30, width: 1280, height: 820 },
  );
  assert.deepEqual(
    fitWindowBounds({ y: 0, width: 1280, height: 820 }, area),
    { x: -80, y: 0, width: 1280, height: 820 },
  );
});
