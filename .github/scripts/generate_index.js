const { execSync } = require('child_process');
const fs = require('fs');

async function main() {
    console.log('Fetching all existing GitHub releases...');
    let existingReleases = [];
    try {
        const output = execSync('gh release list --limit 1000 --json tagName,assets,isPrerelease,createdAt,publishedAt', { encoding: 'utf8' });
        existingReleases = JSON.parse(output);
    } catch (e) {
        console.error('Failed to list existing releases. Make sure GITHUB_TOKEN is set and gh cli is authenticated.');
        process.exit(1);
    }

    const versions = {
        release: {},
        preview: {}
    };

    for (const release of existingReleases) {
        // Skip releases that are not Minecraft versions (like java-jre)
        if (release.tagName === 'java-jre' || !release.tagName.startsWith('v')) {
            continue;
        }

        const version = release.tagName.substring(1);
        
        let url = "";
        let isGdk = false;
        
        // Find the main appx or msixvc asset (ignoring .001 volume files, we just want the base link)
        const asset = release.assets.find(a => a.name.endsWith('.appx') || a.name.endsWith('.msixvc') || a.name.endsWith('.msixvc.7z') || a.name.endsWith('.msixvc.7z.001') || a.name === 'bedrock_app.7z');
        if (asset) {
            url = asset.url; // url to download
            if (asset.name.includes('.msixvc') || asset.name.includes('bedrock_app')) {
                isGdk = true;
            }
        } else {
            // Some releases might not have assets uploaded yet
            continue;
        }
        
        // Check preview
        const isPreview = release.isPrerelease || version.includes('beta') || version.includes('preview');
        
        const type = isPreview ? 'preview' : 'release';
        
        versions[type][version] = {
            url: url,
            is_gdk: isGdk,
            published_at: release.publishedAt || release.createdAt
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
