// offscreen/ocr.js
// PaddleOCR 运行时封装：单例懒初始化 + 推理串行队列

const DET_MODEL_DIR = '../paddlejs/models/det';
const REC_MODEL_DIR = '../paddlejs/models/rec';

let ocrInstance = null;
let ocrInitPromise = null;
let queue = Promise.resolve();

export function initOcrOnce() {
  if (!ocrInitPromise) {
    ocrInitPromise = (async () => {
      const mod = await import('./ocr-lib.js');
      ocrInstance = await mod.init(
        { dir: DET_MODEL_DIR },
        { dir: REC_MODEL_DIR }
      );
      return ocrInstance;
    })();
  }
  return ocrInitPromise;
}

export function recognizeOnce(image) {
  queue = queue.then(async () => {
    if (!ocrInstance) await initOcrOnce();
    return ocrInstance.recognize(image);
  });
  return queue;
}

export function disposeOcr() {
  ocrInstance = null;
  ocrInitPromise = null;
  queue = Promise.resolve();
}