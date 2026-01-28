// hash.js
const argon2 = require('argon2');

(async () => {
  const hash = await argon2.hash("admin", {
    type: argon2.argon2id,
    timeCost: 3,
    memoryCost: 65536,
    parallelism: 1
  });

  console.log("NEW HASH:\n", hash);
})();
