const axios = require('axios');
async function run() {
  const slug = `btc-updown-5m-1784669400`;
  const res = await axios.get(`https://gamma-api.polymarket.com/events?slug=${slug}`);
  console.log(JSON.stringify(res.data[0].markets[0], null, 2));
}
run();
