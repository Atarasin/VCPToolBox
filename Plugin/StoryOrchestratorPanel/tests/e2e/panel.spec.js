const { test, expect } = require('@playwright/test');

const BASE_URL = 'http://10.126.126.2:6005/AdminPanel/StoryOrchestrator/';

test.describe('StoryOrchestrator Panel', () => {
  
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.error(`Console error: ${msg.text()}`);
      }
    });
    
    page.on('pageerror', error => {
      console.error(`Page error: ${error.message}`);
    });
  });

  test('page loads without errors', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);
    
    const sidebar = await page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    
    const mainContent = await page.locator('.main-content');
    await expect(mainContent).toBeVisible();
    
    await page.screenshot({ path: 'test-results/01-initial-load.png' });
  });

  test('Stories page loads correctly', async ({ page }) => {
    await page.goto(`${BASE_URL}#/stories`);
    await page.waitForTimeout(2000);
    
    const header = await page.locator('h2');
    await expect(header).toContainText('Stories');
    
    await page.screenshot({ path: 'test-results/02-stories-page.png', fullPage: true });
  });

  test('Review Queue page loads correctly', async ({ page }) => {
    await page.goto(`${BASE_URL}#/review-queue`);
    await page.waitForTimeout(2000);
    
    const header = await page.locator('h2');
    await expect(header).toContainText('Review Queue');
    
    await page.screenshot({ path: 'test-results/03-review-queue.png', fullPage: true });
  });

  test('navigation works', async ({ page }) => {
    await page.goto(`${BASE_URL}#/stories`);
    await page.waitForTimeout(1000);
    
    await page.click('a[href="#\/review-queue"]');
    await page.waitForTimeout(1000);
    
    await expect(page).toHaveURL(/.*review-queue/);
    
    await page.screenshot({ path: 'test-results/04-navigation.png' });
  });

  test('no JavaScript errors in console', async ({ page }) => {
    const errors = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.goto(BASE_URL);
    await page.waitForTimeout(3000);
    
    await page.goto(`${BASE_URL}#/stories`);
    await page.waitForTimeout(1000);
    
    await page.goto(`${BASE_URL}#/review-queue`);
    await page.waitForTimeout(1000);
    
    expect(errors).toHaveLength(0);
  });

  test('API endpoints are accessible', async ({ request }) => {
    const response = await request.get('http://10.126.126.2:6005/admin_api/story-orchestrator-panel/stories');
    expect(response.ok()).toBeTruthy();
    
    const data = await response.json();
    expect(data).toHaveProperty('success');
  });
});
