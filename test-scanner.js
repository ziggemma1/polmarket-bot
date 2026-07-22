const axios = require('axios');
async function run() {
  const { data } = await axios.get('https://gamma-api.polymarket.com/events', {
    params: {
      active: true,
      closed: false,
      limit: 1000
    }
  });
  console.log("Got events:", data.length);
  const markets = [];
  data.forEach(event => {
    if (event.markets) {
      markets.push(...event.markets);
    }
  });
  console.log("Total markets:", markets.length);
  const btc5m = markets.filter(m => m.slug && m.slug.match(/^btc-updown-5m-\d+$/));
  console.log("BTC 5m markets:", btc5m.length);
  if (btc5m.length > 0) {
    console.log(btc5m[0].slug, btc5m[0].endDate);
  }
}
run();
