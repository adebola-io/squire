use anyhow::Result;
use squire_server::{http, store::HomeInUse};

fn print_help() {
    println!("squire {}", env!("CARGO_PKG_VERSION"));
    println!("Personal agent with a local chat UI and hosted Remote Access.");
    println!();
    println!("USAGE:");
    println!("    squire [FLAGS]");
    println!();
    println!("Starts Squire and opens it in your browser.");
    println!();
    println!("COMMANDS:");
    println!("    service install     Keep Squire running in the background, also after restarts");
    println!("    service uninstall   Stop the background service and remove it");
    println!("    service status      Show whether the service is running");
    println!();
    println!("FLAGS:");
    println!("        --no-browser    Start without opening the browser");
    println!("    -h, --help          Print this help message");
    println!("    -V, --version       Print version information");
    println!();
    println!("The server reads settings from ~/.squire/settings.json");
    println!("unless SQUIRE_HOME is set. The local web UI uses");
    println!("port 4296 by default.");
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Kernel lock helper contract for the managed browser runtime: the
    // vendored `driver.cjs` spawns `<helper> --internal-lock <file>`, waits
    // for `locked` on stdout, and ends stdin to release. Ownership comes only
    // from kernel file locks; file contents are never consulted.
    if args.first().is_some_and(|arg| arg == "--internal-lock") {
        let Some(path) = args.get(1).map(std::path::PathBuf::from) else {
            eprintln!("internal lock path is required");
            std::process::exit(2);
        };
        let code = squire_server::wasm_locks::run_internal_lock(&path)?;
        std::process::exit(code);
    }
    if args.first().is_some_and(|arg| arg == "service") {
        let code = squire_server::service::run(&args[1..]).unwrap_or_else(|error| {
            eprintln!("error: {error:#}");
            1
        });
        std::process::exit(code);
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("squire {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return Ok(());
    }
    let mut open_browser = true;
    for arg in &args {
        match arg.as_str() {
            "--no-browser" => open_browser = false,
            other => {
                eprintln!("error: unknown argument `{other}`");
                eprintln!();
                print_help();
                std::process::exit(2);
            }
        }
    }

    let _ = dotenvy::dotenv();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let config = squire_server::config::Config::load()?;
            let port = config.web_port;
            let settings = config.storage.squire_home.join("settings.json");
            // The home lock, not the port, says whether Squire is running:
            // taking it is atomic, so two launches at once cannot both start.
            let state = match squire_server::state::AppState::from_config(config) {
                Ok(state) => state,
                Err(error) if error.downcast_ref::<HomeInUse>().is_some() => {
                    let url = http::ui_url(port);
                    println!("Squire is already running at {url}");
                    if open_browser && squire_server::local_open::open_url(&url) {
                        println!("Opened it in your browser.");
                    }
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            squire_server::first_run::start(&state)?;
            state.agent.schedule_catalog_refresh();
            squire_server::plugins::schedule_mcp_startup_refresh(&state);
            state.mcp_runtime.clone().spawn_idle_eviction();
            match http::serve(state, open_browser).await {
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::AddrInUse) =>
                {
                    eprintln!("error: another program is using port {port}, which Squire needs.");
                    eprintln!(
                        "Close that program, or set a different `ports.web` in {}.",
                        settings.display()
                    );
                    std::process::exit(1);
                }
                result => result,
            }
        })
}
