#[tauri::command]
pub fn worktree_create(repo_path: String, worktree_path: String, branch: String) -> Result<String, String> {
    // Check if branch already exists
    let branch_exists = Command::new("git")
        .args(["-C", &repo_path, "rev-parse", "--verify", &branch])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let args: Vec<&str> = if branch_exists {
        // Checkout existing branch into new worktree
        vec!["-C", &repo_path, "worktree", "add", &worktree_path, &branch]
    } else {
        // Create new branch in new worktree
        vec!["-C", &repo_path, "worktree", "add", "-b", &branch, &worktree_path]
    };

    let out = Command::new("git")
        .args(&args)
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    if out.status.success() {
        Ok(worktree_path)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Removes a git worktree when the runbox is deleted.
#[tauri::command]
pub fn worktree_remove(repo_path: String, worktree_path: String) -> Result<(), String> {
    let out = Command::new("git")
        .args(["-C", &repo_path, "worktree", "remove", "--force", &worktree_path])
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Lists all worktrees for a repo — useful for the dashboard later.
#[tauri::command]
pub fn worktree_list(repo_path: String) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args(["-C", &repo_path, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("git error: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let paths = stdout
        .lines()
        .filter(|l| l.starts_with("worktree "))
        .map(|l| l.trim_start_matches("worktree ").to_string())
        .collect();
    Ok(paths)
}