import * as fs from 'fs'
import {Octokit} from '@octokit/core'
import {
  Endpoints,
  ReposGetReleaseByTagResponseData,
  ReposListReleasesResponseData,
  ReposCreateReleaseResponseData
} from '@octokit/types'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as path from 'path'
import * as glob from 'glob'

type RepoAssetsResp = Endpoints['GET /repos/:owner/:repo/releases/:release_id/assets']['response']
type UploadAssetResp = Endpoints['POST /repos/:owner/:repo/releases/:release_id/assets{?name,label}']['response']
type ReleaseData =
  | ReposGetReleaseByTagResponseData
  | ReposListReleasesResponseData[0]
  | ReposCreateReleaseResponseData
async function get_release_by_tag(
  tag: string,
  prerelease: boolean,
  release_name: string,
  body: string,
  octokit: Octokit
): Promise<ReleaseData> {
  try {
    core.debug(`Getting release by tag ${tag}`)
    const resp = await octokit.repos.getReleaseByTag({
      ...repo(),
      tag: tag
    })
    return resp.data
  } catch (error) {
    if (error.status !== 404) {
      core.debug(`Failed to get release by tag. Not a 404 error. Throwing.`)
      throw error
    }
  }

  // If we get 404, we need to check the release drafts.

  try {
    core.debug('Checking to see if a release draft with the tag exists.')
    const resp = await octokit.repos.listReleases(repo())
    let found = false
    let draftRelease = resp.data[0]
    for (const release of resp.data) {
      if (release.tag_name === tag) {
        draftRelease = release
        found = true
        break
      }
    }
    if (found) {
      core.debug('Found release draft with the given tag.')
      return draftRelease
    }
  } catch (error) {
    core.debug(`Failed to list the releases. Throwing.`)
    throw error
  }

  // If we failed to find a release draft, we need to create the release first.

  core.debug(`Release for tag ${tag} doesn't exist yet so we'll create it now.`)
  const resp = octokit.repos.createRelease({
    ...repo(),
    tag_name: tag,
    prerelease: prerelease,
    name: release_name,
    body: body
  })
  return resp.data
}

async function upload_to_release(
  releaseData: ReleaseData,
  file: string,
  asset_name: string,
  tag: string,
  overwrite: boolean,
  octokit: Octokit
): Promise<undefined | string> {
  const stat = fs.statSync(file)
  if (!stat.isFile()) {
    console.log(`Skipping ${file}, since its not a file`)
    return
  }
  const file_size = stat.size
  const file_bytes = fs.readFileSync(file)

  // Check for duplicates.
  const assets: RepoAssetsResp = await octokit.repos.listReleaseAssets({
    ...repo(),
    release_id: releaseData.id
  })
  const duplicate_asset = assets.data.find(a => a.name === asset_name)
  if (duplicate_asset !== undefined) {
    if (overwrite) {
      console.log(
        `An asset called ${asset_name} already exists in release ${tag} so we'll overwrite it.`
      )
      await octokit.repos.deleteReleaseAsset({
        ...repo(),
        asset_id: duplicate_asset.id
      })
    } else {
      core.setFailed(`An asset called ${asset_name} already exists.`)
      return duplicate_asset.browser_download_url
    }
  } else {
    console.log(
      `No pre-existing asset called ${asset_name} found in release ${tag}. All good.`
    )
  }

  console.log(`Uploading ${file} to ${asset_name} in release ${tag}.`)
  const uploaded_asset: UploadAssetResp = await octokit.repos.uploadReleaseAsset(
    {
      url: releaseData.upload_url,
      name: asset_name,
      data: file_bytes,
      headers: {
        'content-type': 'binary/octet-stream',
        'content-length': file_size
      }
    }
  )
  return uploaded_asset.data.browser_download_url
}

function repo(): {owner: string; repo: string} {
  const repo_name = core.getInput('repo_name')
  // If we're not targeting a foreign repository, we can just return immediately and don't have to do extra work.
  if (!repo_name) {
    return github.context.repo
  }
  const owner = repo_name.substr(0, repo_name.indexOf('/'))
  if (!owner) {
    throw new Error(`Could not extract 'owner' from 'repo_name': ${repo_name}.`)
  }
  const repo = repo_name.substr(repo_name.indexOf('/') + 1)
  if (!repo) {
    throw new Error(`Could not extract 'repo' from 'repo_name': ${repo_name}.`)
  }
  return {
    owner,
    repo
  }
}

async function run(): Promise<void> {
  try {
    // Get the inputs from the workflow file: https://github.com/actions/toolkit/tree/master/packages/core#inputsoutputs
    const token = core.getInput('repo_token', {required: true})
    const file = core.getInput('file', {required: true})
    const tag = core
      .getInput('tag', {required: true})
      .replace('refs/tags/', '')
      .replace('refs/heads/', '')

    const file_glob = core.getInput('file_glob') == 'true' ? true : false
    const overwrite = core.getInput('overwrite') == 'true' ? true : false
    const prerelease = core.getInput('prerelease') == 'true' ? true : false
    const release_name = core.getInput('release_name')
    const body = core.getInput('body')

    const octokit: Octokit = github.getOctokit(token)
    const release = await get_release_by_tag(
      tag,
      prerelease,
      release_name,
      body,
      octokit
    )

    if (file_glob) {
      const files = glob.sync(file)
      if (files.length > 0) {
        for (const file of files) {
          const asset_name = path.basename(file)
          const asset_download_url = await upload_to_release(
            release,
            file,
            asset_name,
            tag,
            overwrite,
            octokit
          )
          core.setOutput('browser_download_url', asset_download_url)
        }
      } else {
        core.setFailed('No files matching the glob pattern found.')
      }
    } else {
      const asset_name =
        core.getInput('asset_name') !== ''
          ? core.getInput('asset_name').replace(/\$tag/g, tag)
          : path.basename(file)
      const asset_download_url = await upload_to_release(
        release,
        file,
        asset_name,
        tag,
        overwrite,
        octokit
      )
      core.setOutput('browser_download_url', asset_download_url)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
