using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

static class Installer {
  [STAThread]
  static void Main(string[] args) {
    string forced = null;
    bool noRun = false;
    foreach (var arg in args) {
      if (arg.StartsWith("/DIR=", StringComparison.OrdinalIgnoreCase)) forced = arg.Substring(5);
      if (arg.Equals("/NORUN", StringComparison.OrdinalIgnoreCase)) noRun = true;
    }
    if (forced != null) { Install(forced, noRun); return; }
    using (var dialog = new FolderBrowserDialog()) {
      dialog.Description = "选择招聘智能体安装文件夹";
      dialog.SelectedPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "招聘智能体");
      if (dialog.ShowDialog() != DialogResult.OK) return;
      Install(dialog.SelectedPath, noRun);
    }
  }

  static void Install(string target, bool noRun) {
    string temp = Path.Combine(target, ".installer-temp");
    Directory.CreateDirectory(temp);
    try {
      Extract("jobagent-payload.7z", Path.Combine(temp, "payload.7z"));
      Extract("7za.exe", Path.Combine(temp, "7za.exe"));
      Directory.CreateDirectory(target);
      var process = Process.Start(new ProcessStartInfo {
        FileName = Path.Combine(temp, "7za.exe"),
        Arguments = "x \"" + Path.Combine(temp, "payload.7z") + "\" -o\"" + target + "\" -y",
        CreateNoWindow = true,
        UseShellExecute = false
      });
      process.WaitForExit();
      if (process.ExitCode != 0) throw new Exception("解压失败，退出码 " + process.ExitCode);
      string exe = Path.Combine(target, "招聘智能体.exe");
      var shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
      dynamic shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "招聘智能体.lnk")
      });
      shortcut.TargetPath = exe;
      shortcut.WorkingDirectory = target;
      shortcut.IconLocation = exe;
      shortcut.Save();
      dynamic shortcut2 = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "招聘智能体.lnk")
      });
      shortcut2.TargetPath = exe;
      shortcut2.WorkingDirectory = target;
      shortcut2.IconLocation = exe;
      shortcut2.Save();
      if (!noRun) Process.Start(new ProcessStartInfo { FileName = exe, WorkingDirectory = target, UseShellExecute = true });
    } catch (Exception error) {
      MessageBox.Show(error.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    } finally {
      try { Directory.Delete(temp, true); } catch { }
    }
  }

  static void Extract(string name, string path) {
    using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
    using (var file = File.Create(path)) {
      if (stream == null) throw new Exception("安装包资源缺失：" + name);
      stream.CopyTo(file);
    }
  }
}
