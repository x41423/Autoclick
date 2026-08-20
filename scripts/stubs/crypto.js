export default {};
export const randomBytes = (n) => { const arr = new Uint8Array(n); for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256); return arr; };
export const createHash = () => { throw new Error('crypto: browser build'); };
export const createHmac = () => { throw new Error('crypto: browser build'); };
export const createCipheriv = () => { throw new Error('crypto: browser build'); };
export const createDecipheriv = () => { throw new Error('crypto: browser build'); };
export const timingSafeEqual = () => { throw new Error('crypto: browser build'); };