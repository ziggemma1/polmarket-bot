import * as dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient, Side, OrderType, SignatureTypeV2 } from '@polymarket/clob-client-v2';

dotenv.config();

async function testOrder() {
  const pk = process.env.POLYGON_PRIVATE_KEY?.trim() || '';
  const proxy = process.env.PROXY_ADDRESS?.trim() || '';

  const wallet = new Wallet(pk);
  console.log('Wallet Signer Address (EOA):', wallet.address);
  console.log('Proxy Address:              ', proxy);

  // Test different signature types: 0 (EOA), 1 (POLY_PROXY), 2 (POLY_GNOSIS_SAFE)
  for (const st of [
    { name: 'POLY_PROXY (1)', type: SignatureTypeV2.POLY_PROXY },
    { name: 'POLY_GNOSIS_SAFE (2)', type: SignatureTypeV2.POLY_GNOSIS_SAFE },
    { name: 'EOA (0)', type: SignatureTypeV2.EOA }
  ]) {
    console.log(`\n--- Testing ${st.name} ---`);
    try {
      const isProxy = st.type !== SignatureTypeV2.EOA;
      const client = new ClobClient({
        host: 'https://clob.polymarket.com',
        chain: 137 as any,
        signer: wallet as any,
        creds: undefined,
        signatureType: st.type,
        funderAddress: isProxy ? proxy : undefined
      });

      const creds = await client.createOrDeriveApiKey();
      console.log(`Derived API Key for ${st.name}:`, creds?.key ? 'SUCCESS' : 'NONE');

      const authedClient = new ClobClient({
        host: 'https://clob.polymarket.com',
        chain: 137 as any,
        signer: wallet as any,
        creds: creds,
        signatureType: st.type,
        funderAddress: isProxy ? proxy : undefined
      });

      // Test checking balance/allowance via CLOB client
      try {
        const bal = await authedClient.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
        console.log(`CLOB getBalanceAllowance for ${st.name}:`, bal);
      } catch (e: any) {
        console.log(`CLOB getBalanceAllowance error for ${st.name}:`, e?.response?.data || e.message);
      }

    } catch (e: any) {
      console.log(`Failed ${st.name}:`, e?.response?.data || e.message);
    }
  }
}

testOrder().catch(console.error);
