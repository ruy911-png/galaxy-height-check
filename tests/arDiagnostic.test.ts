// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArDiagnostic, type ArUpdate } from '../src/arDiagnostic';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(requestSession: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: { requestSession },
  });
  const updates: ArUpdate[] = [];
  const diagnostic = new ArDiagnostic({
    host: document.createElement('div'),
    overlay: document.createElement('div'),
    onUpdate: (update) => updates.push(update),
  });
  return { diagnostic, updates };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'xr');
});

describe('AR cancellation owns native permissions and session shutdown', () => {
  it('keeps restart locked until a late session is ended, and shares concurrent stops', async () => {
    const requested = deferred<XRSession>();
    const ended = deferred<void>();
    const session = new EventTarget() as XRSession;
    session.end = vi.fn(async () => {
      await ended.promise;
      session.dispatchEvent(new Event('end'));
    });
    const requestSession = vi.fn().mockReturnValue(requested.promise);
    const { diagnostic, updates } = setup(requestSession);

    const starting = diagnostic.start();
    expect(requestSession).toHaveBeenCalledTimes(1);
    const stopping = diagnostic.stop();
    const stoppingAgain = diagnostic.stop();
    expect(updates.at(-1)?.phase).toBe('stopping');
    expect(diagnostic.confirmSurface()).toBeNull();
    await diagnostic.start();
    expect(requestSession).toHaveBeenCalledTimes(1);

    requested.resolve(session);
    await starting;
    await Promise.resolve();
    expect(session.end).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)?.phase).toBe('stopping');
    await diagnostic.start();
    expect(requestSession).toHaveBeenCalledTimes(1);

    ended.resolve();
    await Promise.all([stopping, stoppingAgain]);
    expect(updates.at(-1)?.phase).toBe('ended');

    requestSession.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    await diagnostic.start();
    expect(requestSession).toHaveBeenCalledTimes(2);
    expect(updates.at(-1)?.phase).toBe('error');
  });

  it('finishes a cancelled permission request when the user denies it', async () => {
    const requested = deferred<XRSession>();
    const { diagnostic, updates } = setup(vi.fn().mockReturnValue(requested.promise));
    const starting = diagnostic.start();
    const stopping = diagnostic.stop();
    expect(updates.at(-1)?.phase).toBe('stopping');
    requested.reject(new DOMException('Denied', 'NotAllowedError'));
    await Promise.all([starting, stopping]);
    expect(updates.at(-1)?.phase).toBe('ended');
  });

  it('does not unlock restart when session.end rejects before a native end event', async () => {
    const requested = deferred<XRSession>();
    const session = new EventTarget() as XRSession;
    session.end = vi.fn().mockRejectedValue(new Error('Native session is still active'));
    const requestSession = vi.fn().mockReturnValue(requested.promise);
    const { diagnostic, updates } = setup(requestSession);
    const starting = diagnostic.start();
    const stopping = diagnostic.stop();
    requested.resolve(session);
    await Promise.all([starting, stopping]);
    expect(updates.at(-1)?.phase).toBe('stopping');
    expect(updates.at(-1)?.message).toContain('브라우저의 AR 닫기');
    await diagnostic.start();
    expect(requestSession).toHaveBeenCalledTimes(1);

    session.dispatchEvent(new Event('end'));
    await Promise.resolve();
    await Promise.resolve();
    expect(updates.at(-1)?.phase).toBe('ended');
  });
});
