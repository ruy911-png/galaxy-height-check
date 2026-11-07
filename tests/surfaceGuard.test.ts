import { describe, expect, it } from 'vitest';
import { SurfaceGuard } from '../src/surfaceGuard';

const floor = { x: 1, y: 0, z: -2 };

describe('SurfaceGuard: only current, recent tracking data can be confirmed', () => {
  it('requires an active tracking generation', () => {
    const guard = new SurfaceGuard();
    expect(guard.offer(floor, 1000, 0)).toBe(false);
    expect(guard.read(1000)).toBeNull();
    const generation = guard.begin();
    expect(guard.offer(floor, 1000, generation)).toBe(true);
    expect(guard.read(1000)).toEqual(floor);
  });

  it('rejects a stale hit even when the rendering loop has stopped', () => {
    const guard = new SurfaceGuard(250);
    guard.offer(floor, 1000, guard.begin());
    expect(guard.read(1250)).toEqual(floor);
    expect(guard.read(1251)).toBeNull();
  });

  it('clears the previous hit on a frame without a surface or with lost tracking', () => {
    const guard = new SurfaceGuard();
    guard.offer(floor, 1000, guard.begin());
    guard.clear();
    expect(guard.read(1001)).toBeNull();
  });

  it('does not accept delayed data from a prior coordinate system', () => {
    const guard = new SurfaceGuard();
    const oldGeneration = guard.begin();
    guard.offer(floor, 1000, oldGeneration);
    guard.end();
    const newGeneration = guard.begin();
    expect(guard.read(1001)).toBeNull();
    expect(guard.offer(floor, 1001, oldGeneration)).toBe(false);
    expect(guard.offer({ x: 0, y: 2.4, z: -1 }, 1002, newGeneration)).toBe(true);
    expect(guard.read(1002)).toEqual({ x: 0, y: 2.4, z: -1 });
  });

  it('rejects confirmation after AR ends', () => {
    const guard = new SurfaceGuard();
    const generation = guard.begin();
    guard.offer(floor, 1000, generation);
    guard.end();
    expect(guard.read(1001)).toBeNull();
    expect(guard.offer(floor, 1002, generation)).toBe(false);
  });

  it('rejects invalid coordinates and timestamps', () => {
    const guard = new SurfaceGuard();
    const generation = guard.begin();
    guard.offer(floor, 999, generation);
    expect(guard.offer({ x: NaN, y: 1, z: 2 }, 1000, generation)).toBe(false);
    expect(guard.read(1000)).toBeNull();
    expect(guard.offer(floor, Infinity, generation)).toBe(false);
    guard.offer(floor, 1000, generation);
    expect(guard.read(999)).toBeNull();
  });

  it('returns copies so a UI cannot mutate the tracked candidate', () => {
    const guard = new SurfaceGuard();
    const point = { ...floor };
    guard.offer(point, 1000, guard.begin());
    point.y = 99;
    const confirmed = guard.read(1000)!;
    confirmed.y = 88;
    expect(guard.read(1000)).toEqual(floor);
  });
});
