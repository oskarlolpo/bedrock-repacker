const { execSync } = require('child_process');
const fs = require('fs');

async function main() {
    console.log('Fetching all existing GitHub releases via API...');
    let existingReleases = [];
    try {
        const token = process.env.GH_TOKEN;
        const headers = token ? { 'Authorization': `token ${token}` } : {};
        
        let page = 1;
        while (true) {
            console.log(`Fetching page ${page}...`);
            const res = await fetch(`https://api.github.com/repos/oskarlolpo/bedrock-repacker/releases?per_page=100&page=${page}`, { headers });
            if (!res.ok) {
                console.error(`Failed to fetch releases: ${res.statusText}`);
                break;
            }
            
            const data = await res.json();
            if (data.length === 0) {
                break;
            }
            
            existingReleases.push(...data);
            page++;
        }
    } catch (e) {
        console.error('Exception while fetching releases:', e.message);
        process.exit(1);
    }

    const versions = {
        release: {},
        preview: {}
    };

    for (const release of existingReleases) {
        // Skip releases that are not Minecraft versions (like java-jre)
        // REST API uses tag_name, not tagName
        const tagName = release.tag_name;
        if (tagName === 'java-jre' || !tagName.startsWith('v')) {
            continue;
        }

        const version = tagName.substring(1);
        
        let url = "";
        let isGdk = false;
        
        // Find the main appx or msixvc asset
        // Prefer: .appx > .msixvc.7z.001 (split archive) > .msixvc > bedrock_app.7z.*
        const assets = release.assets || [];
        const nameLower = (a) => a.name.toLowerCase();
        const asset = assets.find(a => nameLower(a).endsWith('.appx'))
            || assets.find(a => nameLower(a).endsWith('.msixvc.7z.001'))
            || assets.find(a => nameLower(a).endsWith('.msixvc'))
            || assets.find(a => a.name.startsWith('bedrock_app.7z'));
        
        if (asset) {
            // browser_download_url is the public download link in the REST API
            url = asset.browser_download_url;
            const n = nameLower(asset);
            if (n.includes('.msixvc') || n.startsWith('bedrock_app')) {
                isGdk = true;
            }
        } else {
            // Some releases might not have assets uploaded yet — skip
            continue;
        }
        
        // Check preview — REST API uses prerelease, not isPrerelease
        const isPreview = release.prerelease || version.includes('beta') || version.includes('preview');
        
        const type = isPreview ? 'preview' : 'release';
        
        versions[type][version] = {
            url: url,
            is_gdk: isGdk,
            published_at: release.published_at || release.created_at
        };
    }

    // Write to versions.json
    fs.writeFileSync('versions.json', JSON.stringify(versions, null, 2));
    console.log('Successfully generated versions.json with ' + (Object.keys(versions.release).length + Object.keys(versions.preview).length) + ' versions.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
