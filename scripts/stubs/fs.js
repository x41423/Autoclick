export default {};
export const readFileSync = () => { throw new Error('fs: browser build'); };
export const existsSync = () => false;
export const statSync = () => { throw new Error('fs: browser build'); };
export const mkdirSync = () => {};
export const writeFileSync = () => {};
export const createWriteStream = () => { throw new Error('fs: browser build'); };
export const createReadStream = () => { throw new Error('fs: browser build'); };
export const promises = {};