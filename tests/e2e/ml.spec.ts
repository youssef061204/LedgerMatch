import {test,expect} from '@playwright/test';

test('evaluation dashboard reads measured artifacts and switches partitions',async({page},info)=>{
  await page.goto('/evaluation');
  await expect(page.getByRole('heading',{name:'Measured. Not assumed.'})).toBeVisible();
  const report=await (await page.request.get('/evaluation/latest.json')).json();
  await expect(page.locator('.eval-card').first()).toContainText((report.test.models.xgboost.top1Accuracy*100).toFixed(2)+'%');
  await page.getByRole('button',{name:'Withheld corruptions'}).click();
  await expect(page.locator('.eval-card').first()).toContainText((report.robustness.models.xgboost.top1Accuracy*100).toFixed(2)+'%');
  await page.getByLabel('Example category').selectOption('model_failure');
  await expect(page.locator('.eval-examples article').first()).toBeVisible();
  await page.getByRole('button',{name:'Held-out test',exact:true}).click();
  await page.screenshot({path:info.outputPath('evaluation-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{name:'Measured. Not assumed.'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('evaluation-mobile.png'),fullPage:true});
});

test('live exception panel presents model confidence while preserving human confirmation',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Try demo'}).click();
  await page.getByRole('button',{name:'Load sample data',exact:true}).first().click();
  await page.getByRole('button',{name:'Run reconciliation',exact:true}).click();
  await expect.poll(async()=> (await (await page.request.get('/api/state')).json()).run?.status,{timeout:90000}).toBe('completed');
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Exceptions/}).click();
  await page.getByRole('textbox',{name:'Search records'}).fill('PAY-1001');
  await page.getByRole('button',{name:'Review payment PAY-1001',exact:true}).click();
  await expect(page.getByTestId('ml-recommendation')).toContainText('Calibrated on synthetic data');
  await expect(page.getByRole('button',{name:'Allocate payment',exact:true})).toBeDisabled();
  const detail=await (await page.request.get('/api/payments/PAY-1001')).json();
  expect(detail.payment.allocation).toBeNull();expect(detail.payment.recommendation.modelId).toMatch(/^lm-/);
});
