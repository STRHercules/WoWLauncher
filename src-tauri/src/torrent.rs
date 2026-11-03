//! Embedded BitTorrent bootstrap; completed files are promoted by the source installer.
use super::*;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, Session, SessionOptions, TorrentStatsState};

pub fn is_torrent_source(url: &Url) -> bool {
    url.scheme() == "magnet" || matches!(url.scheme(), "http" | "https") && url.path().to_ascii_lowercase().ends_with(".torrent")
}

// Resolve the client layout before allocating/downloading potentially hundreds of GB.
fn client_payload(paths: &[PathBuf]) -> Result<PathBuf, String> {
    for path in paths {
        validate_relative_path(&path.to_string_lossy())?;
        if path.components().any(|part| match part {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                name.eq_ignore_ascii_case(".launcher") || name.contains(':') || name.contains('\\')
            }
            _ => true,
        }) {
            return Err(format!("Unsafe torrent path: {}", path.display()));
        }
    }
    let clients: Vec<_> = paths
        .iter()
        .filter(|path| path.file_name().is_some_and(|name| name.eq_ignore_ascii_case("Wow.exe")))
        .collect();
    if clients.len() == 1 {
        return Ok(clients[0].parent().unwrap_or(Path::new("")).to_path_buf());
    }
    if clients.is_empty() && paths.len() == 1 && paths[0].extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) {
        return Ok(paths[0].clone());
    }
    Err("The torrent must contain one client with Wow.exe, or a single client ZIP.".to_string())
}

async fn wait_for_pause(paused: &AtomicBool) {
    loop {
        if paused.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

pub async fn download(
    source: &str,
    work: &Path,
    paused: &AtomicBool,
    on_progress: impl Fn(&str, u64, u64, u64),
) -> Result<PathBuf, String> {
    let payload = work.join("payload");
    let session = Session::new_with_opts(
        payload.clone(),
        SessionOptions {
            dht: Some(DhtSessionConfig {
                persistence: None,
                ..Default::default()
            }),
            listen: Some(Default::default()),
            disable_local_service_discovery: true,
            ..Default::default()
        },
    )
    .await
    .map_err(|error| format!("Could not start torrent engine: {error:#}"))?;
    let _cancel_on_drop = session.cancellation_token().clone().drop_guard();
    let result = async {
        on_progress("resolving-torrent", 0, 0, 0);
        let metadata_path = work.join("client.torrent");
        let input = match fs::read(&metadata_path) {
            Ok(bytes) => AddTorrent::from_bytes(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AddTorrent::from_url(source),
            Err(error) => return Err(format!("Could not read torrent metadata: {error}")),
        };
        let metadata = tokio::select! {
            _ = wait_for_pause(paused) => return Err(extras::PAUSED_MESSAGE.to_string()),
            resolved = timeout(Duration::from_secs(180), session.add_torrent(input, Some(AddTorrentOptions {
                list_only: true,
                output_folder: Some(payload.to_string_lossy().into_owned()),
                ..Default::default()
            }))) => resolved.map_err(|_| "Could not resolve torrent metadata within three minutes. Check that seeders are online.".to_string())?
                .map_err(|error| format!("Could not resolve torrent: {error:#}"))?,
        };
        let AddTorrentResponse::ListOnly(metadata) = metadata else {
            return Err("Could not inspect torrent metadata.".to_string());
        };
        let paths: Vec<_> = metadata.info.iter_file_details_ext()
            .map(|file| file.details.filename.to_pathbuf()).collect();
        let client = client_payload(&paths)?;
        let metadata_temp = work.join("client.torrent.tmp");
        fs::write(&metadata_temp, &metadata.torrent_bytes).map_err(|error| format!("Could not save torrent metadata: {error}"))?;
        fs::rename(&metadata_temp, &metadata_path).map_err(|error| format!("Could not commit torrent metadata: {error}"))?;
        let handle = session.add_torrent(AddTorrent::from_bytes(metadata.torrent_bytes), Some(AddTorrentOptions {
            overwrite: true, // Existing partial files are hash-checked before downloading missing pieces.
            output_folder: Some(payload.to_string_lossy().into_owned()),
            initial_peers: Some(metadata.seen_peers),
            ..Default::default()
        })).await.map_err(|error| format!("Could not start torrent download: {error:#}"))?
            .into_handle().ok_or_else(|| "Torrent download did not start.".to_string())?;
        loop {
            if paused.load(Ordering::Relaxed) { return Err(extras::PAUSED_MESSAGE.to_string()); }
            let stats = handle.stats();
            if let Some(error) = stats.error { return Err(format!("Torrent download failed: {error}")); }
            let phase = if matches!(stats.state, TorrentStatsState::Initializing { .. }) { "checking-torrent" } else { "downloading-torrent" };
            let speed = stats.live.as_ref().map(|live| live.download_speed.as_bytes()).unwrap_or(0);
            on_progress(phase, stats.progress_bytes, stats.total_bytes, speed);
            if paused.load(Ordering::Relaxed) { return Err(extras::PAUSED_MESSAGE.to_string()); }
            if stats.finished { return Ok(payload.join(client)); }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }.await;
    // Release file handles before promotion, and never seed after completion or errors.
    session.stop().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires ESTERIA_TEST_MAGNET and live seeders; resolves metadata only"]
    async fn live_magnet_metadata() {
        let source = env::var("ESTERIA_TEST_MAGNET").expect("set ESTERIA_TEST_MAGNET");
        let temp = tempfile::tempdir().unwrap();
        let session = Session::new_with_opts(
            temp.path().to_path_buf(),
            SessionOptions {
                dht: Some(DhtSessionConfig {
                    persistence: None,
                    ..Default::default()
                }),
                listen: Some(Default::default()),
                disable_local_service_discovery: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let _guard = session.cancellation_token().clone().drop_guard();
        let resolved = timeout(
            Duration::from_secs(60),
            session.add_torrent(
                AddTorrent::from_url(source),
                Some(AddTorrentOptions {
                    list_only: true,
                    ..Default::default()
                }),
            ),
        )
        .await;
        session.stop().await;
        let AddTorrentResponse::ListOnly(metadata) = resolved.expect("metadata lookup timed out").expect("metadata lookup failed") else {
            panic!("expected metadata");
        };
        let paths: Vec<_> = metadata
            .info
            .iter_file_details_ext()
            .map(|file| file.details.filename.to_pathbuf())
            .collect();
        println!(
            "Resolved {:?}: {} files, client payload {}",
            metadata.info_hash,
            paths.len(),
            client_payload(&paths).expect("unsupported client layout").display()
        );
        for path in paths.iter().take(8) {
            println!("{}", path.display());
        }
    }

    #[test]
    fn source_detection_and_client_layout() {
        assert!(is_torrent_source(
            &Url::parse("magnet:?xt=urn:btih:98cfaabfd088aeadc9835e5bc0650032ce39f821").unwrap()
        ));
        assert!(is_torrent_source(
            &Url::parse("https://example.com/CLIENT.TORRENT?token=123").unwrap()
        ));
        assert!(!is_torrent_source(&Url::parse("https://example.com/client.zip").unwrap()));
        assert!(!is_torrent_source(&Url::parse("file:///client.torrent").unwrap()));
        let paths = |values: &[&str]| values.iter().map(PathBuf::from).collect::<Vec<_>>();
        assert_eq!(client_payload(&paths(&["Wow.exe", "Data/patch.mpq"])).unwrap(), PathBuf::new());
        assert_eq!(
            client_payload(&paths(&["Esteria/Live/Wow.exe", "Esteria/Live/Data/patch.mpq"])).unwrap(),
            PathBuf::from("Esteria/Live")
        );
        assert_eq!(client_payload(&paths(&["Esteria.zip"])).unwrap(), PathBuf::from("Esteria.zip"));
        for invalid in [
            vec!["../Wow.exe"],
            vec!["C:/Wow.exe"],
            vec![".launcher/Wow.exe"],
            vec!["Wow.exe", "PTR/Wow.exe"],
            vec!["readme.txt"],
            vec!["client.zip", "readme.txt"],
        ] {
            assert!(client_payload(&paths(&invalid)).is_err(), "{invalid:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn local_torrent_transfer_pause_resume_and_magnet() {
        use librqbit::{create_torrent, spawn_utils::BlockingSpawner, CreateTorrentOptions, ListenerOptions};
        use tokio::net::TcpListener;
        let temp = tempfile::tempdir().unwrap();
        let seed = temp.path().join("seed");
        fs::create_dir_all(seed.join("Data")).unwrap();
        let content: Vec<u8> = (0..4 * 1024 * 1024).map(|index| (index % 251) as u8).collect();
        fs::write(seed.join("Wow.exe"), b"test client").unwrap();
        fs::write(seed.join("Data/patch.mpq"), &content).unwrap();
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_addr = http.local_addr().unwrap();
        let torrent = create_torrent(
            &seed,
            CreateTorrentOptions {
                trackers: vec![format!("http://{http_addr}/announce")],
                piece_length: Some(16384),
                ..Default::default()
            },
            &BlockingSpawner::new(1),
        )
        .await
        .unwrap();
        let bytes = torrent.as_bytes().unwrap();
        let magnet = torrent.as_magnet().to_string();
        let seeder = Session::new_with_opts(
            seed.clone(),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                listen: Some(ListenerOptions {
                    listen_addr: "127.0.0.1:0".parse().unwrap(),
                    ipv4_only: true,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let _seed_guard = seeder.cancellation_token().clone().drop_guard();
        let seed_handle = seeder
            .add_torrent(
                AddTorrent::from_bytes(bytes.clone()),
                Some(AddTorrentOptions {
                    output_folder: Some(seed.to_string_lossy().into_owned()),
                    overwrite: true,
                    ..Default::default()
                }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        seed_handle.wait_until_completed().await.unwrap();
        let seed_port = seeder.listen_addr().unwrap().port().to_be_bytes();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = http.accept().await.unwrap();
                let mut request = vec![0; 8192];
                let size = socket.read(&mut request).await.unwrap();
                let body = if request[..size].starts_with(b"GET /client.torrent ") {
                    bytes.to_vec()
                } else {
                    let mut reply = b"d8:intervali1e5:peers6:".to_vec();
                    reply.extend_from_slice(&[127, 0, 0, 1, seed_port[0], seed_port[1]]);
                    reply.push(b'e');
                    reply
                };
                socket
                    .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        let result = timeout(Duration::from_secs(45), async {
            let work = temp.path().join("download");
            fs::create_dir_all(&work).unwrap();
            let pause = AtomicBool::new(false);
            let source = format!("http://{http_addr}/client.torrent");
            let paused = download(&source, &work, &pause, |phase, _, _, _| {
                if phase == "downloading-torrent" {
                    pause.store(true, Ordering::SeqCst);
                }
            })
            .await
            .unwrap_err();
            assert_eq!(paused, extras::PAUSED_MESSAGE);
            assert!(work.join("client.torrent").is_file());
            // Simulate a restart with an incomplete/corrupt piece, not just a clean cached download.
            fs::write(work.join("payload/Data/patch.mpq"), b"bad partial piece").unwrap();
            pause.store(false, Ordering::SeqCst);
            let client = download(&source, &work, &pause, |_, _, _, _| {}).await.unwrap();
            assert_eq!(fs::read(client.join("Data/patch.mpq")).unwrap(), content);
            assert_eq!(fs::read(client.join("Wow.exe")).unwrap(), b"test client");
            let magnet_work = temp.path().join("magnet");
            fs::create_dir_all(&magnet_work).unwrap();
            let client = download(&magnet, &magnet_work, &pause, |_, _, _, _| {}).await.unwrap();
            assert_eq!(fs::read(client.join("Data/patch.mpq")).unwrap(), content);
            fs::rename(&client, temp.path().join("installed")).expect("torrent engine released its file handles");
        })
        .await;
        server.abort();
        seeder.stop().await;
        result.expect("local torrent transfer timed out");
    }
}
