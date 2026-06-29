/**
 * fix_gdk_releases.js
 * 
 * Finds GDK versions that were incorrectly saved as .Appx (without is_gdk=true)
 * and re-triggers the repack workflow with is_gdk=true.
 * 
 * A GDK version is one that exists in urls.min.json from GdkLinks repo.
 */

const { execSync } = require('child_process');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runCmd(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (e) {
        return null;
    }
}

async function main() {
    // 1. Fetch all GDK versions from GdkLinks
    console.log('Fetching GDK urls.min.json...');
    const gdkRes = await fetch('https://raw.githubusercontent.com/MinecraftBedrockArchiver/GdkLinks/refs/heads/master/urls.min.json');
    const gdkData = await gdkRes.json();
    
    // Build a map: version -> {url, isPreview}
    const gdkVersions = {};
    for (const [type, entries] of Object.entries(gdkData)) {
        const isPreview = type === 'preview';
        for (const [version, urls] of Object.entries(entries)) {
            const urlList = Array.isArray(urls) ? urls : [urls];
            if (urlList.length > 0) {
                gdkVersions[version] = { url: urlList[0], isPreview };
            }
        }
    }
    console.log(`Found ${Object.keys(gdkVersions).length} GDK versions in source.`);

    // 2. Fetch all existing GitHub releases
    console.log('Fetching GitHub releases...');
    const token = process.env.GH_TOKEN;
    const headers = token ? { 'Authorization': `token ${token}` } : {};
    
    let releases = [];
    let page = 1;
    while (true) {
        const res = await fetch(`https://api.github.com/repos/oskarlolpo/bedrock-repacker/releases?per_page=100&page=${page}`, { headers });
        if (!res.ok) break;
        const data = await res.json();
        if (data.length === 0) break;
        releases.push(...data);
        page++;
    }
    console.log(`Fetched ${releases.length} GitHub releases.`);

    // 3. Find GDK versions that have .Appx instead of .msixvc / bedrock_app.7z
    const toFix = [];
    
    for (const release of releases) {
        const tagName = release.tag_name;
        if (!tagName.startsWith('v')) continue;
        const version = tagName.substring(1);
        
        // Is this version a GDK version?
        if (!gdkVersions[version]) continue;
        
        const assets = release.assets || [];
        
        // A GDK release is CORRECT only if it has .msixvc or .msixvc.7z.NNN assets
        // bedrock_app.7z alone with .Appx = wrong (Appx is actually the msixvc renamed incorrectly)
        const hasMsixvc = assets.some(a => 
            a.name.toLowerCase().endsWith('.msixvc') ||
            /\.msixvc\.7z\.\d+$/.test(a.name.toLowerCase())
        );
        const hasWrongAppx = assets.some(a => a.name.toLowerCase().endsWith('.appx'));
        
        if (!hasMsixvc && hasWrongAppx) {
            console.log(`[NEEDS FIX] v${version} - has .Appx (wrong!) but needs .msixvc (GDK)`);
            toFix.push({
                version,
                url: gdkVersions[version].url,
                isPreview: gdkVersions[version].isPreview
            });
        } else if (!hasMsixvc && !hasWrongAppx) {
            console.log(`[MISSING PKG] v${version} - no package at all`);
            toFix.push({
                version,
                url: gdkVersions[version].url,
                isPreview: gdkVersions[version].isPreview
            });
        } else {
            console.log(`[OK] v${version} - has correct .msixvc`);
        }
    }
    
    // Also check for completely missing GDK versions
    const existingTags = new Set(releases.map(r => r.tag_name));
    for (const [version, info] of Object.entries(gdkVersions)) {
        if (!existingTags.has(`v${version}`)) {
            console.log(`[NEW] v${version} - not in repo at all`);
            toFix.push({ version, url: info.url, isPreview: info.isPreview });
        }
    }

    console.log(`\nTotal versions to fix/add: ${toFix.length}`);
    if (toFix.length === 0) {
        console.log('All GDK versions are correct!');
        return;
    }

    // 4. Trigger repack workflows
    const limit = Math.min(toFix.length, 50); // Limit batch size
    console.log(`Triggering ${limit} workflows (batch of 50 max)...\n`);
    
    for (let i = 0; i < limit; i++) {
        const job = toFix[i];
        const cmd = `gh workflow run repack.yml -f version="${job.version}" -f url="${job.url}" -f is_preview="${job.isPreview}" -f is_gdk="true"`;
        console.log(`[${i+1}/${limit}] ${job.version} -> ${cmd}`);
        const result = runCmd(cmd);
        if (result !== null) {
            console.log(`  ✓ Triggered`);
        } else {
            console.log(`  ✗ Failed to trigger`);
        }
        await sleep(3000); // 3 sec between triggers
    }
    
    console.log('\nDone! Run again to process the next batch.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
