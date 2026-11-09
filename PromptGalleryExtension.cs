using Microsoft.AspNetCore.Builder;
using SwarmUI.Accounts;
using SwarmUI.Core;
using SwarmUI.Utils;
using System.IO;

namespace PromptGallery;

/// <summary>Prompt Gallery: a visual, per-model-profile library of prompt fragments (image + caption + text), organized in folders.</summary>
public class PromptGalleryExtension : Extension
{
    public static PermInfoGroup PermGroup = new("Prompt Gallery", "Permissions for the Prompt Gallery extension.");

    public static PermInfo PermView = Permissions.Register(new("prompt_gallery_view", "[Prompt Gallery] View", "Allows browsing the prompt gallery and inserting its cards into prompts.", PermissionDefault.USER, PermGroup, PermSafetyLevel.SAFE));

    public static PermInfo PermEdit = Permissions.Register(new("prompt_gallery_edit", "[Prompt Gallery] Edit", "Allows creating, editing and deleting prompt gallery profiles, folders and cards (writes files on the server).", PermissionDefault.USER, PermGroup, PermSafetyLevel.UNTESTED));

    public override void OnPreInit()
    {
        ScriptFiles.Add("Assets/prompt_gallery.js");
        StyleSheetFiles.Add("Assets/prompt_gallery.css");
    }

    public override void OnInit()
    {
        PromptGalleryAPI.Register();
        Logs.Init($"[PromptGallery] Data folder: {GalleryStore.Root}");
    }

    public override void OnPreLaunch()
    {
        // The web app is built by now but not started yet, so routes can still be added.
        WebServer.WebApp.MapGet("/PromptGalleryImage/{*path}", PromptGalleryAPI.ViewImage);
        WebServer.WebApp.MapGet("/PromptGalleryExport/{*path}", PromptGalleryAPI.ExportPack);
        WebServer.WebApp.MapPost("/PromptGalleryImport", PromptGalleryAPI.ImportPack);
        // Pick up cards edited directly on disk while the server was off. Runs in the background so startup isn't delayed.
        Task.Run(GalleryWildcards.SyncAll);
    }
}
