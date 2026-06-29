use clap::{Parser, Subcommand};
use futures_util::StreamExt;
use reqwest::Client;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use tracing::{error, info};
use std::process::Command;

mod gdk;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Download, extract and repack a Bedrock package
    Repack {
        /// URL of the .msixvc package
        #[arg(short, long)]
        url: String,

        /// Output directory for the 7z parts
        #[arg(short, long)]
        output: PathBuf,
        
        /// Compression volume size (e.g., "1000m" for 1000 MB)
        #[arg(short, long, default_value = "1000m")]
        volume_size: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();

    match &cli.command {
        Commands::Repack { url, output, volume_size } => {
            info!("Starting repack process for {}", url);
            
            // 1. Download
            std::fs::create_dir_all(&output)?;
            let extension = if url.to_lowercase().ends_with(".appx") { "appx" } else { "msixvc" };
            let package_name = format!("original_package.{}", extension);
            let msixvc_path = output.join(&package_name);
            
            let temp_dir = std::env::temp_dir().join("bedrock-repacker");
            std::fs::create_dir_all(&temp_dir)?;
            
            info!("Downloading to {:?}", msixvc_path);
            let client = Client::new();
            let res = client.get(url).send().await?;
            if !res.status().is_success() {
                error!("Failed to download: {}", res.status());
                return Err("Download failed".into());
            }
            
            let total_size = res.content_length().unwrap_or(0);
            info!("File size: {} bytes", total_size);
            
            let mut file = File::create(&msixvc_path)?;
            let mut stream = res.bytes_stream();
            let mut downloaded = 0u64;
            let mut last_log = std::time::Instant::now();
            
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                file.write_all(&chunk)?;
                downloaded += chunk.len() as u64;
                
                if last_log.elapsed().as_secs() >= 2 {
                    info!("Downloaded {} / {}", downloaded, total_size);
                    last_log = std::time::Instant::now();
                }
            }
            info!("Download complete.");
            
            // 2. Extract
            let extract_dir = temp_dir.join("extracted");
            if extract_dir.exists() {
                std::fs::remove_dir_all(&extract_dir)?;
            }
            
            info!("Extracting package to {:?}", extract_dir);
            let mut extracted = false;
            if let Ok(mut stream) = gdk::stream::MsiXVDStream::new(&msixvc_path) {
                if stream.extract_to(&extract_dir, &()).is_ok() {
                    extracted = true;
                }
            }

            if !extracted {
                info!("Not a valid MsiXVC stream, attempting standard 7z extraction (for .appx)...");
                let status = Command::new("7z")
                    .arg("x")
                    .arg(msixvc_path.to_str().unwrap())
                    .arg(format!("-o{}", extract_dir.to_str().unwrap()))
                    .status()?;
                if !status.success() {
                    error!("Standard extraction failed");
                    return Err("Extraction failed".into());
                }
            }
            info!("Extraction complete.");
            
            // 3. Repack to 7z
            info!("Repacking extracted files to {:?}", output);
            std::fs::create_dir_all(output)?;
            
            let archive_name = output.join("bedrock_app.7z");
            
                // Using system 7z command
            // On ubuntu github runners, 7z command comes from p7zip-full
            let status = Command::new("7z")
                .arg("a")
                .arg("-mx=3") // Fast compression
                .arg(format!("-v{}", volume_size))
                .arg(archive_name.to_str().unwrap())
                // Ensure we pack the contents, not the folder itself
                .arg(format!("{}/*", extract_dir.to_str().unwrap()))
                .status()?;
                
            if !status.success() {
                error!("7z compression failed with status: {}", status);
                return Err("7z compression failed".into());
            }
            
            info!("Repack complete! Artifacts are in {:?}", output);
            
            // Cleanup
            std::fs::remove_dir_all(&temp_dir)?;
        }
    }

    Ok(())
}
