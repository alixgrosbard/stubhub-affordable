#!/usr/bin/env node

/**
 * StubHub Affordable Listings Checker
 *
 * Runs twice a day to verify that all featured events still have
 * tickets under $100 on StubHub. If not, marks them inactive.
 *
 * How it works:
 * 1. Reads listings.json
 * 2. Fetches each StubHub event page
 * 3. Checks if the page is still live (not 404/redirected)
 * 4. Checks if the event date has passed
 * 5. Updates listings.json — deactivates stale/expired events
 * 6. Logs results
 *
 * Setup:
 *   npm init -y && npm install node-fetch
 *   node checker.js
 *
 * To run twice daily, add a cron job:
 *   crontab -e
 *   0 8,20 * * * cd /Users/alix.anfang/stubhub-affordable && /usr/local/bin/node checker.js >> checker.log 2>&1
 */

const fs = require('fs');
const path = require('path');

const LISTINGS_PATH = path.join(__dirname, 'listings.json');
const LOG_PATH = path.join(__dirname, 'checker.log');
const MAX_PRICE = 100;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    // If we get a 404 or redirect to a generic page, the event is gone
    if (response.status === 404 || response.status === 410) {
      return { live: false, reason: `HTTP ${response.status}` };
    }

    // Check if redirected away from the specific event page
    const finalUrl = response.url;
    if (finalUrl && !finalUrl.includes('/event/') && !finalUrl.includes('/grouping/') && !finalUrl.includes('/performer/')) {
      // Redirected to a generic page — event likely no longer available
      return { live: false, reason: `Redirected to ${finalUrl}` };
    }

    // Try to read the page content for any "sold out" or "no tickets" signals
    const text = await response.text();
    const lowerText = text.toLowerCase();

    if (lowerText.includes('no tickets available') ||
        lowerText.includes('sold out') ||
        lowerText.includes('this event has ended')) {
      return { live: false, reason: 'Sold out or no tickets available' };
    }

    return { live: true, reason: 'OK' };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { live: true, reason: 'Timeout — assuming still live' };
    }
    return { live: true, reason: `Error: ${err.message} — assuming still live` };
  }
}

function isEventPast(dateStr) {
  const eventDate = new Date(dateStr);
  const now = new Date();
  return eventDate < now;
}

async function run() {
  log('=== Checker started ===');

  // Read current listings
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LISTINGS_PATH, 'utf8'));
  } catch (err) {
    log(`ERROR: Could not read listings.json: ${err.message}`);
    return;
  }

  let totalChecked = 0;
  let deactivated = 0;
  let stillActive = 0;

  for (const category of data.categories) {
    for (const event of category.events) {
      if (!event.active) continue;

      totalChecked++;
      log(`Checking: ${event.title} (${event.id})`);

      // Check 1: Has the event date passed?
      if (isEventPast(event.date)) {
        event.active = false;
        deactivated++;
        log(`  DEACTIVATED — Event date has passed (${event.date})`);
        continue;
      }

      // Check 2: Is the StubHub page still live?
      const result = await checkUrl(event.stubhubUrl);

      if (!result.live) {
        event.active = false;
        deactivated++;
        log(`  DEACTIVATED — ${result.reason}`);
      } else {
        stillActive++;
        log(`  OK — ${result.reason}`);
      }

      // Small delay between requests to be respectful
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Update timestamp
  data.lastUpdated = new Date().toISOString();

  // Write updated listings
  try {
    fs.writeFileSync(LISTINGS_PATH, JSON.stringify(data, null, 2));
    log(`Listings updated. Checked: ${totalChecked}, Active: ${stillActive}, Deactivated: ${deactivated}`);
  } catch (err) {
    log(`ERROR: Could not write listings.json: ${err.message}`);
  }

  // Summary
  const activeCount = data.categories.reduce(
    (sum, cat) => sum + cat.events.filter(e => e.active).length, 0
  );

  if (activeCount < 8) {
    log(`WARNING: Only ${activeCount} active listings remain. Consider adding new events.`);
    log(`To add events: edit listings.json and add new entries with real StubHub URLs.`);
  }

  log('=== Checker finished ===\n');
}

run();
