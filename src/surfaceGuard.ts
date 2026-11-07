export interface SurfaceSample {
  x: number;
  y: number;
  z: number;
}

/** Stores only a hit from the current tracking generation and a recent frame. */
export class SurfaceGuard {
  private active = false;
  private generation = 0;
  private candidate: { point: SurfaceSample; at: number; generation: number } | null = null;

  constructor(readonly maxAgeMs = 250) {}

  begin(): number {
    this.generation += 1;
    this.active = true;
    this.clear();
    return this.generation;
  }

  clear(): void {
    this.candidate = null;
  }

  end(): void {
    this.active = false;
    this.generation += 1;
    this.clear();
  }

  offer(point: SurfaceSample, at: number, generation: number): boolean {
    this.clear();
    if (
      !this.active ||
      generation !== this.generation ||
      ![point.x, point.y, point.z, at].every(Number.isFinite)
    ) {
      return false;
    }
    this.candidate = { point: { ...point }, at, generation };
    return true;
  }

  read(now: number): SurfaceSample | null {
    const hit = this.candidate;
    if (
      !this.active ||
      !hit ||
      hit.generation !== this.generation ||
      !Number.isFinite(now) ||
      now < hit.at ||
      now - hit.at > this.maxAgeMs
    ) {
      this.clear();
      return null;
    }
    return { ...hit.point };
  }
}
