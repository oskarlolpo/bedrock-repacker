const { execSync } = require('child_process');
const fs = require('fs');

async function main() {
    console.log('Fetching GDK urls.min.json...');
    const response = await fetch('https://raw.githubusercontent.com/MinecraftBedrockArchiver/GdkLinks/refs/heads/master/urls.min.json');
    if (!response.ok) {
        throw new Error(`Failed to fetch GDK links: ${response.statusText}`);
    const gdkData = await response.json();

    console.log('Fetching OnixClient releases...');
    let onixData = [];
    try {
        const onixRes = await fetch('https://api.github.com/repos/OnixClient/onix_compatible_appx/releases?per_page=100');
        if (onixRes.ok) {
            onixData = await onixRes.json();
        }
    } catch (e) {
        console.error('Failed to fetch OnixClient releases', e.message);
    }

    console.log('Fetching existing GitHub releases...');
    let existingReleases = [];
    try {
        const output = execSync('gh release list --limit 1000 --json tagName', { encoding: 'utf8' });
        const releases = JSON.parse(output);
        existingReleases = releases.map(r => r.tagName);
    } catch (e) {
        console.error('Failed to list existing releases. Make sure GITHUB_TOKEN is set and gh cli is authenticated.');
        process.exit(1);
    }

    console.log(`Found ${existingReleases.length} existing releases.`);

    const toTrigger = [];

    // Process both release and preview
    for (const type of ['release', 'preview']) {
        if (!gdkData[type]) continue;
        const isPreview = type === 'preview';

        for (const [version, urls] of Object.entries(gdkData[type])) {
            // We expect the tag to be v1.26.40.20
            const expectedTag = `v${version}`;

            if (existingReleases.includes(expectedTag)) {
                // Already have this release
                continue;
            }

            // Also check if the alternative tag exists (like v1.26.4020.0)
            // Just in case we already created it earlier
            // A simple heuristic is we just rely on exactly v1.26.40.20
            
            // Get the first URL in the array
            if (!Array.isArray(urls) || urls.length === 0) continue;
            const url = urls[0];

            toTrigger.push({ version, url, isPreview });
        }
    }

    // Process OnixClient releases
    for (const release of onixData) {
        const version = release.tag_name; // e.g. "1.26.10"
        const expectedTag = `v${version}`;
        if (existingReleases.includes(expectedTag)) {
            continue;
        }
        
        const asset = release.assets.find(a => a.name.endsWith('.appx') || a.name.endsWith('.msixvc'));
        if (asset) {
            toTrigger.push({ version: version, url: asset.browser_download_url, isPreview: false });
        }
    }

    console.log(`Found ${toTrigger.length} missing releases to process.`);

    // Sort to process oldest first (simple string comparison is mostly fine, or we can just process as is)
    // Actually, gdkData is somewhat sorted, but we don't strictly need to order them for a cron sync.
    // We'll reverse just in case so oldest ones are triggered first.
    toTrigger.reverse();

    for (const item of toTrigger) {
        console.log(`Triggering workflow for ${item.version} (Preview: ${item.isPreview})`);
        const workflowName = 'repack.yml';

        try {
            const cmd = `gh workflow run ${workflowName} -f version="${item.version}" -f url="${item.url}" -f is_preview="${item.isPreview}"`;
            execSync(cmd, { stdio: 'inherit' });
            console.log('Waiting 5 seconds...');
            execSync('sleep 5');
        } catch (e) {
            console.error(`Failed to trigger workflow for ${item.version}:`, e.message);
        }
    }
    
    console.log('Sync complete.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
