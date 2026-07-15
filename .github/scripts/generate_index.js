const { execSync } = require('child_process');
const fs = require('fs');

// Semver-compatible sort comparator for Minecraft versions (a.b.c.d)
function compareMcVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

async function main() {
    console.log('Fetching all existing GitHub releases via API...');
    let existingReleases = [];
    try {
        const token = process.env.GH_TOKEN;
        const headers = token ? { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' } : {};
        
        let page = 1;
        while (true) {
            console.log(`Fetching page ${page}...`);
            const res = await fetch(`https://api.github.com/repos/oskarlolpo/bedrock-repacker/releases?per_page=100&page=${page}`, { headers });
            if (!res.ok) {
                console.error(`Failed to fetch releases: ${res.statusText}`);
                break;
            }
            
            const data = await res.json();
            if (data.length === 0) break;
            
            existingReleases.push(...data);
            page++;
        }
    } catch (e) {
        console.error('Exception while fetching releases:', e.message);
        process.exit(1);
    }

    console.log(`Fetched ${existingReleases.length} total releases.`);

    const versions = {
        release: {},
        preview: {}
    };

    for (const release of existingReleases) {
        const tagName = release.tag_name;
        // Skip non-Minecraft releases
        if (tagName === 'java-jre' || !tagName.startsWith('v')) continue;

        const version = tagName.substring(1);
        const assets = release.assets || [];

        // === Determine if this is a GDK version ===
        const msixvcAsset = assets.find(a => a.name.toLowerCase().endsWith('.msixvc'));
        const msixvcVolumeAsset = assets.find(a => a.name.toLowerCase().includes('.msixvc.7z.'));
        const bedrockAppAsset = assets.find(a => a.name.startsWith('bedrock_app.7z'));
        const appxAsset = assets.find(a => a.name.toLowerCase().endsWith('.appx'));
        const metaAsset = assets.find(a => a.name === '.bedrin-meta.json');

        // Prefer the authoritative `.bedrin-meta.json` marker written by
        // repack.yml (records the real `--is_gdk` the workflow was invoked
        // with) over guessing from which asset names happen to be present.
        // The guess is unreliable: `bedrock_app.7z` is produced for BOTH GDK
        // and UWP inputs (extraction+repack always runs regardless of
        // `is_gdk`), so a UWP release that also got a `bedrock_app.7z` asset
        // was silently classified as GDK. Fall back to the old heuristic
        // only for releases created before this marker existed.
        let isGdk;
        if (metaAsset) {
            try {
                const metaRes = await fetch(metaAsset.browser_download_url);
                const meta = await metaRes.json();
                isGdk = !!meta.is_gdk;
            } catch (e) {
                console.error(`Failed to read .bedrin-meta.json for v${version}, falling back to heuristic:`, e.message);
                isGdk = !!(msixvcAsset || msixvcVolumeAsset || bedrockAppAsset);
            }
        } else {
            isGdk = !!(msixvcAsset || msixvcVolumeAsset || bedrockAppAsset);
        }

        // === Build URL list ===
        let urls = [];

        if (isGdk) {
            if (bedrockAppAsset) {
                // bedrock_app.7z or bedrock_app.7z.001, .002, ... - collect all parts sorted
                const bedrockParts = assets
                    .filter(a => a.name.startsWith('bedrock_app.7z'))
                    .sort((a, b) => a.name.localeCompare(b.name));
                urls = bedrockParts.map(a => a.browser_download_url);
            } else if (msixvcAsset) {
                // Single .msixvc file (small enough to fit)
                urls = [msixvcAsset.browser_download_url];
            } else if (msixvcVolumeAsset) {
                // Multi-part .msixvc.7z.001, .002, ... — collect all parts sorted
                const volumeParts = assets
                    .filter(a => /\.msixvc\.7z\.\d+$/.test(a.name.toLowerCase()))
                    .sort((a, b) => a.name.localeCompare(b.name));
                urls = volumeParts.map(a => a.browser_download_url);
            }
        } else if (appxAsset) {
            // UWP .Appx file (single)
            urls = [appxAsset.browser_download_url];
        } else {
            // UWP, multi-volume: .appx.7z.001, .002, ... (see mirror_appx.yml,
            // which now splits files over the 2GB GitHub Releases limit the
            // same way the GDK path does).
            const appxVolumeParts = assets
                .filter(a => /\.appx\.7z\.\d+$/.test(a.name.toLowerCase()))
                .sort((a, b) => a.name.localeCompare(b.name));
            if (appxVolumeParts.length > 0) {
                urls = appxVolumeParts.map(a => a.browser_download_url);
            }
        }

        // Skip releases with no valid download links
        if (urls.length === 0) continue;

        // === Determine preview/release ===
        const isPreview = release.prerelease;
        const type = isPreview ? 'preview' : 'release';

        versions[type][version] = {
            urls: urls,
            is_gdk: isGdk,
            published_at: release.published_at || release.created_at
        };
    }

    // === Sort versions newest-first ===
    function sortedObj(obj) {
        return Object.fromEntries(
            Object.entries(obj).sort((a, b) => compareMcVersions(b[0], a[0]))
        );
    }

    const output = {
        release: sortedObj(versions.release),
        preview: sortedObj(versions.preview)
    };

    fs.writeFileSync('versions.json', JSON.stringify(output, null, 2));
    console.log(`Successfully generated versions.json:`);
    console.log(`  Releases: ${Object.keys(output.release).length}`);
    console.log(`  Previews: ${Object.keys(output.preview).length}`);
    console.log(`  Total: ${Object.keys(output.release).length + Object.keys(output.preview).length}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
