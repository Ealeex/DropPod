import { Euler, MathUtils, Vector3 } from 'three';

const heightStep = 0.1;
const gravityAcceleration = 9.81;
const jumpSpeed = 4.5;
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ']);

export function createFlyControls(camera, canvas, { onSpeedStep, onBoostChange, onGravityChange, onGridToggle, onWorldToggle, onSunToggle, findFloor } = {}) {
  const events = new AbortController();
  const options = { signal: events.signal };
  const keys = new Set();
  const angles = new Euler(0, 0, 0, 'YXZ');
  const direction = new Vector3();
  const forward = new Vector3();
  const floorProbe = new Vector3();
  let enabled = false;
  let drag;
  let holdingLeft = false;
  let boosted = false;
  let gravity = false;
  let fallSpeed = 0;
  let grounded = false;
  let eyeHeight = 1.8;
  let groundOffset = 0;

  function setGravity(value) {
    if (gravity === value) return;
    gravity = value;
    fallSpeed = 0;
    grounded = false;
    reportGravity();
  }

  function reportGravity() {
    onGravityChange?.(gravity, eyeHeight, groundOffset);
  }

  function adjustHeight(direction, adjustGround) {
    const previousHeight = eyeHeight + groundOffset;
    if (adjustGround) groundOffset = Math.round((groundOffset + direction * heightStep) * 10) / 10;
    else eyeHeight = Math.max(heightStep, Math.round((eyeHeight + direction * heightStep) * 10) / 10);
    camera.position.y += eyeHeight + groundOffset - previousHeight;
    reportGravity();
  }

  function setBoost(value) {
    if (boosted === value) return;
    boosted = value;
    onBoostChange?.(boosted ? 2 : 1);
  }

  function clearKeys() {
    keys.clear();
    setBoost(false);
  }

  function releaseLeft() {
    holdingLeft = false;
  }

  function look(dx, dy) {
    angles.setFromQuaternion(camera.quaternion);
    angles.y -= dx * 0.003;
    angles.x = MathUtils.clamp(angles.x - dy * 0.003, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    angles.z = 0;
    camera.quaternion.setFromEuler(angles);
  }

  canvas.addEventListener('keydown', (event) => {
    if (!enabled) return;
    if (event.key === 'Escape' && document.pointerLockElement === canvas) {
      event.preventDefault();
      event.stopPropagation();
      document.exitPointerLock();
      return;
    }
    setBoost(event.shiftKey);
    if (event.altKey || event.metaKey) return;
    if (gravity && (event.code === 'NumpadAdd' || event.code === 'NumpadSubtract')) {
      event.preventDefault();
      adjustHeight(event.code === 'NumpadAdd' ? 1 : -1, event.ctrlKey);
      return;
    }
    if (event.code === 'KeyV') {
      const toggle = event.ctrlKey ? onWorldToggle : onGridToggle;
      if (!toggle) return;
      event.preventDefault();
      if (!event.repeat) toggle();
      return;
    }
    if (event.ctrlKey) return;
    if (event.code === 'KeyL' && onSunToggle) {
      event.preventDefault();
      if (!event.repeat) onSunToggle();
      return;
    }
    if (event.code === 'KeyG' && findFloor && document.pointerLockElement === canvas) {
      event.preventDefault();
      if (!event.repeat) setGravity(!gravity);
      return;
    }
    if (gravity && event.code === 'Space') {
      event.preventDefault();
      if (grounded && !event.repeat) {
        fallSpeed = -jumpSpeed;
        grounded = false;
      }
      return;
    }
    if (!movementKeys.has(event.code)) return;
    event.preventDefault();
    keys.add(event.code);
  }, options);
  canvas.addEventListener('keyup', (event) => {
    if (!enabled) return;
    setBoost(event.shiftKey);
    keys.delete(event.code);
  }, options);
  canvas.addEventListener('blur', clearKeys, options);
  window.addEventListener('blur', () => {
    clearKeys();
    releaseLeft();
  }, options);

  canvas.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    holdingLeft = true;
    if (document.pointerLockElement !== canvas) {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }
  }, options);
  canvas.addEventListener('pointermove', (event) => {
    if (!enabled || drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (dx || dy) look(dx, dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
  }, options);
  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) releaseLeft();
  }, options);
  window.addEventListener('pointercancel', releaseLeft, options);
  window.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    const locked = document.pointerLockElement === canvas;
    if (event.ctrlKey && (locked || event.target === canvas)) {
      event.preventDefault();
      event.stopPropagation();
      camera.fov = MathUtils.clamp(camera.fov + Math.sign(event.deltaY) * 4, 20, 100);
      camera.updateProjectionMatrix();
      return;
    }
    if (!enabled || (!holdingLeft && !locked)) return;
    event.preventDefault();
    onSpeedStep?.(-Math.sign(event.deltaY));
  }, { ...options, capture: true, passive: false });
  canvas.addEventListener('lostpointercapture', () => {
    drag = null;
    releaseLeft();
  }, options);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  canvas.addEventListener('mousedown', (event) => {
    if (!enabled || event.button !== 2 || document.pointerLockElement === canvas) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.requestPointerLock?.()?.then(() => {
      if (!enabled && document.pointerLockElement === canvas) document.exitPointerLock();
    }).catch(() => {});
  }, options);
  document.addEventListener('mousemove', (event) => {
    if (enabled && document.pointerLockElement === canvas) look(event.movementX, event.movementY);
  }, options);
  document.addEventListener('pointerlockchange', () => {
    clearKeys();
    releaseLeft();
  }, options);

  function setEnabled(value) {
    enabled = value;
    if (!enabled) setGravity(false);
    clearKeys();
    releaseLeft();
    if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
    drag = null;
    if (enabled) canvas.focus({ preventScroll: true });
    else if (document.pointerLockElement === canvas) document.exitPointerLock();
  }

  return {
    setEnabled,
    update(distance, seconds = 0) {
      direction.set(Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
        gravity ? 0 : Number(keys.has('KeyE')) - Number(keys.has('KeyQ')),
        Number(keys.has('KeyS')) - Number(keys.has('KeyW'))).normalize().multiplyScalar(distance * (boosted ? 2 : 1));
      if (!gravity) {
        camera.translateX(direction.x);
        camera.position.y += direction.y;
        camera.translateZ(direction.z);
        return;
      }

      if (grounded && !direction.x && !direction.z) return;
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const { position } = camera;
      position.x -= forward.z * direction.x + forward.x * direction.z;
      position.z += forward.x * direction.x - forward.z * direction.z;
      fallSpeed += gravityAcceleration * seconds;
      const drop = fallSpeed * seconds;
      if (drop < 0) {
        position.y -= drop;
        return;
      }
      floorProbe.copy(position);
      floorProbe.y -= groundOffset;
      const floor = findFloor(floorProbe, eyeHeight + drop) + groundOffset;
      position.y = Math.max(position.y - drop, floor + eyeHeight);
      grounded = position.y === floor + eyeHeight;
      if (grounded) fallSpeed = 0;
    },
    dispose() {
      setEnabled(false);
      events.abort();
    },
  };
}
