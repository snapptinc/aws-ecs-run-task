const core = require("@actions/core");
const AWS = require("aws-sdk");

const ecs = new AWS.ECS();

const main = async () => {
  const cluster = core.getInput("cluster", { required: true });
  const taskDefinitionFile = core.getInput("task-definition", { required: true });
  const subnets = core.getMultilineInput("subnets", { required: true });
  const securityGroups = core.getMultilineInput("security-groups", {
    required: true,
  });
  const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
        taskDefinitionFile :
        path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
  const fileContents = fs.readFileSync(taskDefPath, 'utf8');
  const taskDefContents = maintainValidObjects(removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents))));
  let registerResponse;
  try {
    registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
  } catch (error) {
    core.setFailed("Failed to register task definition in ECS: " + error.message);
    core.debug("Task definition contents:");
    core.debug(JSON.stringify(taskDefContents, undefined, 4));
    throw(error);
  }
  const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
  core.setOutput('task-definition-arn', taskDefArn);
  const assignPublicIp =
        core.getInput("assign-public-ip", { required: false }) || "ENABLED";
  const overrideContainer = core.getInput("override-container", {
    required: false,
  });
  const overrideContainerCommand = core.getMultilineInput(
      "override-container-command",
      {
        required: false,
      }
  );

  const taskParams = {
    taskDefinition : taskDefArn,
    cluster,
    count: 1,
    launchType: "FARGATE",
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        assignPublicIp,
        securityGroups,
      },
    },
  };

  try {
    if (overrideContainerCommand.length > 0 && !overrideContainer) {
      throw new Error(
          "override-container is required when override-container-command is set"
      );
    }
 
   if (overrideContainer) {
      if (overrideContainerCommand) {
        taskParams.overrides = {
          containerOverrides: [
              {
                name: overrideContainer,
                command: overrideContainerCommand,
              },
          ],
        };
      } else {
        throw new Error(
            "override-container-command is required when override-container is set"
        );
      }
    }

    core.debug("Running task...");
    let task = await ecs.runTask(taskParams).promise();
    const taskArn = task.tasks[0].taskArn;
    core.setOutput("task-arn", taskArn);

    core.debug("Waiting for task to finish...");
    await ecs.waitFor("tasksStopped", { cluster, tasks: [taskArn] }).promise();

    core.debug("Checking status of task");
    task = await ecs.describeTasks({ cluster, tasks: [taskArn] }).promise();
    const exitCode = task.tasks[0].containers[0].exitCode;

    if (exitCode === 0) {
      core.setOutput("status", "success");
    } else {
      core.setFailed(task.tasks[0].stoppedReason);

      const taskHash = taskArn.split("/").pop();
      core.info(
          `task failed, you can check the error on Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${AWS.config.region}#/clusters/${cluster}/tasks/${taskHash}/details`
      );
    }
  } catch (error) {
    core.setFailed(error.message);
  }
};

main();
