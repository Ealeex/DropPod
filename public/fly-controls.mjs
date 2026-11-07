import { Euler, MathUtils, Vector3 } from 'three';

const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF']);

export function createFlyControls(camera, canvas) {
  const events = new AbortController();
  const options = { signal: events.signal };
  const keys = new Set();
  const angles = new Euler(0, 0, 0, 'YXZ');
  const direction = new Vector3();
  let enabled = false;
  let drag;
  let moved = false;

  function look(dx, dy) {
    angles.setFromQuaternion(camera.quaternion);
    angles.y -= dx * 0.003;
    angles.x = MathUtils.clamp(angles.x - dy * 0.003, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    angles.z = 0;
    camera.quaternion.setFromEuler(angles);
  }

  canvas.addEventListener('keydown', (event) => {
    if (!enabled || !movementKeys.has(event.code) || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    keys.add(event.code);
  }, options);
  canvas.addEventListener('keyup', (event) => keys.delete(event.code), options);
  canvas.addEventListener('blur', () => keys.clear(), options);
  window.addEventListener('blur', () => keys.clear(), options);

  canvas.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    moved = false;
    if (document.pointerLockElement !== canvas) {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }
  }, options);
  canvas.addEventListener('pointermove', (event) => {
    if (!enabled || drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx || dy) {
      moved = true;
      look(dx, dy);
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
  }, options);
  canvas.addEventListener('lostpointercapture', () => { drag = null; }, options);
  canvas.addEventListener('click', () => {
    if (enabled && !moved && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.()?.catch(() => {});
    }
  }, options);
  document.addEventListener('mousemove', (event) => {
    if (enabled && document.pointerLockElement === canvas) look(event.movementX, event.movementY);
  }, options);
  document.addEventListener('pointerlockchange', () => keys.clear(), options);

  function setEnabled(value) {
    enabled = value;
    keys.clear();
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    drag = null;
    if (enabled) canvas.focus({ preventScroll: true });
    else if (document.pointerLockElement === canvas) document.exitPointerLock();
  }

  return {
    setEnabled,
    update(distance) {
      direction.set(Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
        Number(keys.has('KeyR')) - Number(keys.has('KeyF')),
        Number(keys.has('KeyS')) - Number(keys.has('KeyW'))).normalize().multiplyScalar(distance);
      camera.translateX(direction.x);
      camera.position.y += direction.y;
      camera.translateZ(direction.z);
    },
    dispose() {
      setEnabled(false);
      events.abort();
    },
  };
}
