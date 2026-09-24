import { DataSource } from 'typeorm';
import { Setting } from './src/settings/setting.entity.js';

const ds = new DataSource({
  type: 'better-sqlite3',
  database: 'db.sqlite',
  entities: [Setting],
});

async function run() {
  await ds.initialize();
  const repo = ds.getRepository(Setting);
  const all = await repo.find();
  console.log('Settings:', all);
  
  // Try saving payment info
  const paymentInfo = {
      bankAccount: {
        bankName: 'CBE',
        accountNumber: '123',
        accountName: 'TEST'
      },
      telebirr: {
        phoneNumber: '0911',
        accountName: 'TEST'
      }
  };
  
  await repo.save({ key: 'shop_payment_info', value: JSON.stringify(paymentInfo) });
  console.log('Saved payment info!');
  
  const all2 = await repo.find();
  console.log('Settings after:', all2);

  await ds.destroy();
}
run().catch(console.error);
