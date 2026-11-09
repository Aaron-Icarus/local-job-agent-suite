using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

static class Installer {
  [STAThread]
  static void Main(string[] args) {
    Application.EnableVisualStyles();
    string forced = null;
    bool noRun = false;
    foreach (var arg in args) {
      if (arg.StartsWith("/DIR=", StringComparison.OrdinalIgnoreCase)) forced = arg.Substring(5);
      if (arg.Equals("/NORUN", StringComparison.OrdinalIgnoreCase)) noRun = true;
    }
    string target = forced;
    if (string.IsNullOrWhiteSpace(target)) {
      using (var dialog = new FolderBrowserDialog()) {
        dialog.Description = "选择招聘智能体安装文件夹";
        dialog.ShowNewFolderButton = true;
        dialog.SelectedPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "招聘智能体");
        if (dialog.ShowDialog() != DialogResult.OK) return;
        target = dialog.SelectedPath;
      }
    }
    var form = new Form { Text = "安装招聘智能体", ClientSize = new Size(480, 150), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
    var label = new Label { Text = "正在准备安装…", AutoSize = false, Left = 24, Top = 24, Width = 430, Height = 40 };
    var bar = new ProgressBar { Left = 24, Top = 75, Width = 430, Height = 24, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 35 };
    form.Controls.Add(label);
    form.Controls.Add(bar);
    form.Shown += (sender, eventArgs) => {
      Task.Run(() => {
        try {
          Log("install start: " + target);
          InstallFiles(target, noRun);
          form.Invoke(new Action(() => { label.Text = "安装完成，正在启动…"; }));
          form.Invoke(new Action(() => form.Close()));
        } catch (Exception error) {
          Log("ERROR: " + error);
          form.Invoke(new Action(() => {
            label.Text = "安装失败：" + error.Message;
            MessageBox.Show(error.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            form.Close();
          }));
        }
      });
    };
    Application.Run(form);
  }

  static void InstallFiles(string target, bool noRun) {
    Directory.CreateDirectory(target);
    string temp = Path.Combine(target, ".installer-temp");
    Directory.CreateDirectory(temp);
    try {
      Log("extract payload");
      Extract("jobagent-payload.7z", Path.Combine(temp, "payload.7z"));
      Extract("7za.exe", Path.Combine(temp, "7za.exe"));
      Log("run 7za");
      var process = Process.Start(new ProcessStartInfo {
        FileName = Path.Combine(temp, "7za.exe"),
        Arguments = "x \"" + Path.Combine(temp, "payload.7z") + "\" -o\"" + target + "\" -y",
        CreateNoWindow = true,
        UseShellExecute = false
      });
      process.WaitForExit();
      if (process.ExitCode != 0) throw new Exception("解压失败，退出码 " + process.ExitCode);
      string exe = Path.Combine(target, "招聘智能体.exe");
      Log("create shortcuts");
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
      Log("start app");
      if (!noRun) Process.Start(new ProcessStartInfo { FileName = exe, WorkingDirectory = target, UseShellExecute = true });
    } finally {
      try { Directory.Delete(temp, true); } catch { }
    }
  }

  static void Log(string text) {
    try {
      string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JobAgent");
      Directory.CreateDirectory(dir);
      File.AppendAllText(Path.Combine(dir, "installer.log"), DateTime.Now.ToString("o") + " " + text + Environment.NewLine);
    } catch { }
  }

  static void Extract(string name, string path) {
    using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
    using (var file = File.Create(path)) {
      if (stream == null) throw new Exception("安装包资源缺失：" + name);
      stream.CopyTo(file);
    }
  }
}
